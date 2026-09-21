export const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const all: readonly Role[] = ROLES;
const upTo = (r: Role): readonly Role[] => ROLES.slice(0, ROLES.indexOf(r) + 1);

export const PERMISSIONS = {
  'workspace:view': all,
  'workspace:manage': upTo('admin'),
  'workspace:delete': upTo('owner'),
  'member:invite': upTo('manager'),
  'member:manage': upTo('admin'),
  'project:view': all,
  'project:create': upTo('manager'),
  'project:edit': upTo('manager'),
  'project:delete': upTo('admin'),
  'task:view': all,
  'task:create': upTo('member'),
  'task:edit': upTo('member'),
  'task:delete': upTo('manager'),
  'chat:read': all,
  'chat:write': upTo('member'),
  'document:view': all,
  'document:upload': upTo('member'),
  'document:delete': upTo('manager'),
  'ai:use': upTo('member'),
  'meeting:manage': upTo('member'),
  'analytics:view': all,
  'billing:manage': upTo('admin'),
  'audit:view': upTo('admin'),
} satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;
export const can = (role: Role, p: Permission) => PERMISSIONS[p].includes(role);
export const outranks = (a: Role, b: Role) => ROLES.indexOf(a) < ROLES.indexOf(b);
