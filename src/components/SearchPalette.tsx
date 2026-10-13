'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Search, ChevronRight, Command } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/format';

interface SearchHit {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export function SearchPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load recent queries from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('bleca_search_recent');
      if (stored) setRecentQueries(JSON.parse(stored));
    } catch {
      // ignore
    }
  }, []);

  // Save recent queries
  const saveRecentQuery = useCallback((q: string) => {
    setRecentQueries((prev) => {
      const filtered = prev.filter((r) => r !== q);
      const updated = [q, ...filtered].slice(0, 5);
      try {
        localStorage.setItem('bleca_search_recent', JSON.stringify(updated));
      } catch {
        // ignore
      }
      return updated;
    });
  }, []);

  // Keyboard shortcut to open (⌘K / Ctrl+K)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen]);

  // Search function
  const performSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) {
      setHits([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      setHits(data.data);
    } catch (err) {
      console.error('Search failed:', err);
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      performSearch(query);
    }, 150);
    return () => clearTimeout(timer);
  }, [query, performSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && hits[selectedIndex]) {
      e.preventDefault();
      window.location.href = hits[selectedIndex].href;
      saveRecentQuery(query);
      setIsOpen(false);
      setQuery('');
    }
  };

  const handleSelectHit = (hit: SearchHit) => {
    window.location.href = hit.href;
    saveRecentQuery(query);
    setIsOpen(false);
    setQuery('');
  };

  const handleClear = () => {
    setQuery('');
    inputRef.current?.focus();
  };

  if (!isOpen) return null;

  const kindLabels: Record<string, string> = {
    transaction: 'Transaction',
    invoice: 'Invoice',
    customer: 'Customer',
    supplier: 'Supplier',
    budget: 'Budget',
    document: 'Document',
    journal: 'Journal Entry',
    account: 'Account',
    project: 'Project',
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4" onClick={() => setIsOpen(false)}>
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={(e) => e.stopPropagation()}
      />
      <div
        ref={containerRef}
        className="relative w-full max-w-2xl bg-white rounded-lg border-border-subtle border shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-4 border-border-subtle border-b bg-white/50">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-border-subtle rounded">
              <Command className="h-3 w-3" /> K
            </kbd>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search transactions, invoices, customers, suppliers…"
              className="w-full pl-10 pr-20 py-2.5 bg-white border-border-subtle border rounded-md text-sm outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent"
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button
                onClick={handleClear}
                className="absolute right-8 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {query.length < 2 ? (
            recentQueries.length > 0 ? (
              <div className="p-4 border-border-subtle border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2 px-4">Recent searches</p>
                <ul className="divide-border-subtle divide-y">
                  {recentQueries.map((rq) => (
                    <li key={rq}>
                      <button
                        onClick={() => {
                          setQuery(rq);
                          setSelectedIndex(0);
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm hover:bg-navy-50 flex items-center justify-between"
                      >
                        <span>{rq}</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground">
                <Search className="h-10 w-10 mx-auto mb-2 opacity-30" />
                <p>Type to search across transactions, invoices, customers, suppliers, budgets, documents, journals, accounts and projects</p>
                <p className="text-xs mt-1">Minimum 2 characters</p>
              </div>
            )
          ) : loading ? (
            <div className="p-8 text-center text-muted-foreground">
              <Search className="h-6 w-6 animate-spin mx-auto mb-2" />
              Searching…
            </div>
          ) : hits.length > 0 ? (
            <ul className="divide-border-subtle divide-y">
              {hits.map((hit, index) => (
                <li
                  key={`${hit.kind}-${hit.id}`}
                  className={cn(
                    'flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors',
                    index === selectedIndex ? 'bg-navy-50' : 'hover:bg-navy-50',
                  )}
                  onClick={() => handleSelectHit(hit)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span
                    className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-navy-100 text-navy-700 text-[11px] font-medium shrink-0"
                  >
                    {hit.kind.charAt(0).toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{hit.title}</p>
                    <p className="text-muted-foreground text-sm truncate">
                      {kindLabels[hit.kind] ?? hit.kind} · {hit.subtitle}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-8 text-center text-muted-foreground">
              <p>No results for "{query}"</p>
              <p className="text-xs mt-1">Try a different search term</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}