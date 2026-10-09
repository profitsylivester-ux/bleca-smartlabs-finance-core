import { describe, expect, it } from 'vitest';
import {
  GROUPS,
  MODULES,
  MODULE_BY_KEY,
  availableModules,
  gate,
  moduleByPath,
} from '@/modules/module-registry';

describe('module registry', () => {
  it('registers at least the Milestone 1 modules as available', () => {
    const available = availableModules().map((m) => m.key);
    expect(available).toContain('USERS_ROLES');
    expect(available).toContain('AUDIT_TRAIL');
    expect(available).toContain('DASHBOARD_CEO');
    expect(available).toContain('DASHBOARD_FINANCE');
  });

  it('declares Phase 2 modules as planned rather than omitting them', () => {
    /**
     * Their permissions are already seeded. A role that can be granted a
     * permission it can never exercise is a data problem waiting to confuse
     * someone, so the registry records the intent and the milestone.
     */
    const planned = MODULES.filter((m) => m.availability === 'PLANNED');
    expect(planned.length).toBeGreaterThan(5);
    expect(planned.every((m) => m.milestone !== null)).toBe(true);
  });

  it('never gives a planned module a route path', () => {
    /**
     * A planned module with a path would produce a navigation link to a page that
     * does not exist. That reads as a bug rather than as a phase boundary.
     */
    for (const plannedModule of MODULES.filter((m) => m.availability === 'PLANNED')) {
      expect(plannedModule.path, `${plannedModule.key} is planned but has a path`).toBeNull();
    }
  });

  it('gives every available module a path and a milestone', () => {
    for (const builtModule of availableModules()) {
      expect(builtModule.path, `${builtModule.key} has no path`).not.toBeNull();
      expect(builtModule.milestone).toBe('M1');
    }
  });

  it('uses unique paths', () => {
    const paths = availableModules().map((m) => m.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('places every module in a declared group', () => {
    const groupKeys = new Set(GROUPS.map((g) => g.key));
    for (const entry of MODULES) {
      expect(groupKeys.has(entry.group), `${entry.key} is in unknown group ${entry.group}`).toBe(
        true,
      );
    }
  });

  it('has no duplicate module keys', () => {
    const keys = MODULES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('looks a module up by path prefix', () => {
    expect(moduleByPath('/admin/users')?.key).toBe('USERS_ROLES');
    expect(moduleByPath('/admin/users/some-sub-page')?.key).toBe('USERS_ROLES');
    expect(moduleByPath('/nowhere')).toBeUndefined();
  });

  it('indexes by key', () => {
    expect(MODULE_BY_KEY.get('AUDIT_TRAIL')?.label).toBe('Audit Trail');
  });
});

describe('gate', () => {
  it('reports an available module the actor may use as AVAILABLE', () => {
    expect(gate({ module: 'USERS_ROLES', granted: true })).toBe('AVAILABLE');
  });

  it('reports an available module the actor may not use as FORBIDDEN', () => {
    expect(gate({ module: 'USERS_ROLES', granted: false })).toBe('FORBIDDEN');
  });

  /**
   * Order matters: an unimplemented module reports NOT_YET_AVAILABLE whether or
   * not the actor is permitted, because "you may not do this" would be a
   * misleading answer to "this does not exist yet".
   */
  it('reports an unimplemented module as NOT_YET_AVAILABLE regardless of permission', () => {
    expect(gate({ module: 'INVOICES', granted: true })).toBe('NOT_YET_AVAILABLE');
    expect(gate({ module: 'INVOICES', granted: false })).toBe('NOT_YET_AVAILABLE');
  });

  it('reports an unknown module as NOT_YET_AVAILABLE', () => {
    expect(gate({ module: 'PROCUREMENT', granted: true })).toBe('NOT_YET_AVAILABLE');
  });
});
