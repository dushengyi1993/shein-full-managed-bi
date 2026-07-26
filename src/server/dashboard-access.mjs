const ROLE_LABELS = Object.freeze({
  admin: '系统管理员',
  manager: '负责人',
  operator: '运营',
  viewer: '只读成员',
});

const WRITE_ROLES = Object.freeze(new Set(['admin', 'manager', 'operator']));
const STORE_CODE_PATTERN = /^[A-Z0-9_-]{1,24}$/;

function assignedStoreCodes(user) {
  if (!Array.isArray(user?.storeCodes)) return [];
  return [...new Set(
    user.storeCodes
      .map((value) => String(value).trim().toUpperCase())
      .filter((value) => STORE_CODE_PATTERN.test(value)),
  )].sort();
}

function accessDescriptor(user) {
  const role = user?.role || 'viewer';
  return {
    username: user?.username || null,
    displayName: user?.displayName || '本地开发',
    employeeCode: user?.employeeCode || null,
    role,
    roleLabel: ROLE_LABELS[role] || ROLE_LABELS.viewer,
    readAllStores: true,
    writeEnabled: false,
    writeAuthorizationSource: 'warehouse_assignment_required',
    declaredStoreCodes: assignedStoreCodes(user),
  };
}

/**
 * Read visibility and write authority are intentionally separate:
 * every authenticated employee may inspect the complete dashboard, while a
 * future write executor must still prove both its global enable flag and the
 * employee's store assignment. The current portal has no write executor.
 */
export function projectDashboardForUser(dashboard, user) {
  return {
    ...dashboard,
    access: accessDescriptor(user),
  };
}

/**
 * Central store-write gate for future executors. Keeping this gate here avoids
 * reusing front-end filters or read visibility as authorization evidence.
 */
export function canWriteStore(
  user,
  storeCode,
  {
    writeEnabled = false,
    authorization = null,
    capability = '',
  } = {},
) {
  if (writeEnabled !== true) return false;
  if (!authorization || typeof authorization !== 'object') return false;
  const employeeCode = String(user?.employeeCode || '').trim();
  if (
    !employeeCode
    || String(authorization.employeeCode || '').trim() !== employeeCode
  ) return false;
  const username = String(user?.username || '').trim();
  const authorizedUsername = String(authorization.username || '').trim();
  if (authorizedUsername && authorizedUsername !== username) return false;
  const role = String(authorization.role || '').trim().toLowerCase();
  if (!WRITE_ROLES.has(role)) return false;
  const normalizedCapability = String(capability || '').trim().toUpperCase();
  if (!/^[A-Z0-9_.:-]{3,80}$/.test(normalizedCapability)) return false;
  const allowedCapabilities = new Set(
    (Array.isArray(authorization.allowedCapabilities)
      ? authorization.allowedCapabilities
      : [])
      .map((value) => String(value).trim().toUpperCase()),
  );
  if (!allowedCapabilities.has(normalizedCapability)) return false;
  const normalizedStoreCode = String(storeCode || '').trim().toUpperCase();
  if (!STORE_CODE_PATTERN.test(normalizedStoreCode)) return false;
  if (role === 'admin' && authorization.allStores === true) return true;
  const assignment = (Array.isArray(authorization.assignments)
    ? authorization.assignments
    : [])
    .find(({ storeCode: assignedCode }) => (
      String(assignedCode || '').trim().toUpperCase() === normalizedStoreCode
    ));
  return ['PRIMARY', 'SUPPORT'].includes(
    String(assignment?.role || '').trim().toUpperCase(),
  );
}
