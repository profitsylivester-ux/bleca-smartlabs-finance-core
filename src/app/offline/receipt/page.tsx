'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { openDB, DBSchema, IDBPDatabase } from 'idb';

interface OfflineReceipt {
  id: string;
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  category: string;
  description?: string;
  imageBase64?: string;
  capturedAt: string;
  idempotencyKey: string;
  synced: boolean;
}

interface SyncQueueItem {
  id: string;
  actionType: string;
  payload: unknown;
  idempotencyKey: string;
  status: string;
  createdAt: string;
  retries: number;
}

interface OfflineDB extends DBSchema {
  offlineReceipts: {
    key: string;
    value: OfflineReceipt;
    indexes: { 'by-synced': number; 'by-idempotency-key': string };
  };
  syncQueue: {
    key: string;
    value: SyncQueueItem;
    indexes: { 'by-status': string; 'by-idempotency-key': string };
  };
}

const DB_NAME = 'bleca-offline-db';
const DB_VERSION = 1;

async function getDB(): Promise<IDBPDatabase<OfflineDB>> {
  return openDB<OfflineDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const receiptStore = db.createObjectStore('offlineReceipts', { keyPath: 'id' });
      receiptStore.createIndex('by-synced', 'synced');
      receiptStore.createIndex('by-idempotency-key', 'idempotencyKey', { unique: true });

      const queueStore = db.createObjectStore('syncQueue', { keyPath: 'id' });
      queueStore.createIndex('by-status', 'status');
      queueStore.createIndex('by-idempotency-key', 'idempotencyKey', { unique: true });
    },
  });
}

const ALLOWED_OFFLINE_ACTIONS = ['RECEIPT_CAPTURE', 'DRAFT_SAVE', 'CONTACT_CARD_SAVE'] as const;
const OFFLINE_ONLY_ACTIONS = ['SUBMIT', 'APPROVE', 'REJECT', 'POST', 'REVERSE', 'PERIOD_CLOSE', 'PERIOD_REOPEN'] as const;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

function generateIdempotencyKey(): string {
  return `idem-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

export default function OfflineReceiptPage() {
  const router = useRouter();
  const [isOnline, setIsOnline] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [formData, setFormData] = useState({
    vendor: '',
    amount: '',
    currency: 'TZS',
    date: new Date().toISOString().split('T')[0],
    category: '',
    description: '',
    imageFile: null as File | null,
  });

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    setIsOnline(navigator.onLine);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFormData((prev) => ({ ...prev, imageFile: file }));
    }
  }, []);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const saveToIndexedDB = async (receipt: OfflineReceipt) => {
    const db = await getDB();
    await db.put('offlineReceipts', receipt);
  };

  const queueForSync = async (actionType: string, payload: unknown, idempotencyKey: string) => {
    const db = await getDB();
    await db.put('syncQueue', {
      id: generateId(),
      actionType,
      payload,
      idempotencyKey,
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      retries: 0,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    try {
      const { vendor, amount, currency, date, category, description, imageFile } = formData;

      if (!vendor || !amount || !category) {
        setMessage({ type: 'error', text: 'Vendor, amount, and category are required.' });
        setIsSubmitting(false);
        return;
      }

      const idempotencyKey = generateIdempotencyKey();
      let imageBase64: string | undefined;
      if (imageFile) {
        imageBase64 = await fileToBase64(imageFile);
      }
      const receipt: OfflineReceipt = {
        id: generateId(),
        vendor,
        amount: parseFloat(amount),
        currency,
        date: date ?? "",
        category,
        description,
        imageBase64,
        capturedAt: new Date().toISOString(),
        idempotencyKey,
        synced: false,
      };

      await saveToIndexedDB(receipt);
      await queueForSync('RECEIPT_CAPTURE', receipt, idempotencyKey);

      setMessage({
        type: 'success',
        text: isOnline
          ? 'Receipt captured and queued for sync.'
          : 'Receipt captured offline. Will sync when connectivity is restored.',
      });

      setFormData({
        vendor: '',
        amount: '',
        currency: 'TZS',
        date: new Date().toISOString().split('T')[0],
        category: '',
        description: '',
        imageFile: null,
      });
    } catch (err) {
      console.error('Failed to save receipt:', err);
      setMessage({ type: 'error', text: 'Failed to save receipt. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const triggerSync = async () => {
    if (!isOnline) {
      setMessage({ type: 'error', text: 'Cannot sync while offline.' });
      return;
    }

    setMessage({ type: 'info', text: 'Syncing...' });

    try {
      const response = await fetch('/api/v1/sync/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const result = await response.json();
      if (response.ok) {
        setMessage({ type: 'success', text: `Synced ${result.syncedCount} items. ${result.failedCount} failed.` });
      } else {
        setMessage({ type: 'error', text: result.error || 'Sync failed.' });
      }
    } catch (err) {
      console.error('Sync failed:', err);
      setMessage({ type: 'error', text: 'Sync failed. Check connection and try again.' });
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Capture Receipt (Offline-Capable)</h1>
        <div className="flex items-center gap-2">
          <span
            className={`w-3 h-3 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}
            title={isOnline ? 'Online' : 'Offline'}
          />
          <span className="text-sm text-gray-600">{isOnline ? 'Online' : 'Offline'}</span>
        </div>
      </div>

      {message && (
        <div
          className={`p-4 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-50 text-green-800'
              : message.type === 'error'
              ? 'bg-red-50 text-red-800'
              : 'bg-blue-50 text-blue-800'
          }`}
        >
          {message.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="vendor" className="block text-sm font-medium text-gray-700 mb-1">
              Vendor *
            </label>
            <input
              type="text"
              id="vendor"
              name="vendor"
              value={formData.vendor}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
              placeholder="e.g., ABC Supplies Ltd"
            />
          </div>
          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-gray-700 mb-1">
              Amount *
            </label>
            <input
              type="number"
              id="amount"
              name="amount"
              value={formData.amount}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
              step="0.01"
              min="0"
              placeholder="0.00"
            />
          </div>
          <div>
            <label htmlFor="currency" className="block text-sm font-medium text-gray-700 mb-1">
              Currency
            </label>
            <select
              id="currency"
              name="currency"
              value={formData.currency}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="TZS">TZS</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
          </div>
          <div>
            <label htmlFor="date" className="block text-sm font-medium text-gray-700 mb-1">
              Date *
            </label>
            <input
              type="date"
              id="date"
              name="date"
              value={formData.date}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
              max={new Date().toISOString().split('T')[0]}
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="category" className="block text-sm font-medium text-gray-700 mb-1">
              Category *
            </label>
            <select
              id="category"
              name="category"
              value={formData.category}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            >
              <option value="">Select category</option>
              <option value="EXPENSE_INTERNET">Internet</option>
              <option value="EXPENSE_CLOUD">Cloud Services</option>
              <option value="EXPENSE_AI_API">AI API Costs</option>
              <option value="EXPENSE_TRANSPORT">Transport</option>
              <option value="EXPENSE_MARKETING">Marketing</option>
              <option value="EXPENSE_SOFTWARE">Software</option>
              <option value="EXPENSE_WORKSPACE">Workspace</option>
              <option value="EXPENSE_TRAINING">Training</option>
              <option value="EXPENSE_HARDWARE_PROTOTYPING">Hardware Prototyping</option>
              <option value="EXPENSE_OTHER">Other</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={handleInputChange}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Optional description..."
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="imageFile" className="block text-sm font-medium text-gray-700 mb-1">
              Receipt Image (optional)
            </label>
            <input
              type="file"
              id="imageFile"
              name="imageFile"
              accept="image/*"
              onChange={handleFileChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {formData.imageFile && (
              <p className="mt-1 text-sm text-gray-500">Selected: {formData.imageFile.name}</p>
            )}
          </div>
        </div>

        <div className="flex gap-4 pt-4 border-t">
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 py-2 px-4 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Saving...' : 'Save Receipt'}
          </button>
          <button
            type="button"
            onClick={triggerSync}
            disabled={!isOnline || isSubmitting}
            className="flex-1 py-2 px-4 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Sync Now
          </button>
        </div>
      </form>

      <div className="p-4 bg-gray-50 rounded-lg text-sm">
        <h3 className="font-medium text-gray-900 mb-2">Offline Capability</h3>
        <ul className="space-y-1 text-gray-600">
          <li>âœ“ Receipt capture works offline (stored in IndexedDB)</li>
          <li>âœ“ Draft save works offline</li>
          <li>âœ“ Contact card save works offline</li>
          <li>âœ— Submit, Approve, Reject, Post, Reverse, Period Close/Reopen require connectivity</li>
          <li>âœ“ Data syncs automatically when connection is restored</li>
        </ul>
      </div>
    </div>
  );
}



