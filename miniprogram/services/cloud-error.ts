// Extract only short diagnostics, never return response bodies, URLs or tokens.
export function cloudFailureCode(error: unknown): string {
  const queue: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  const messages: string[] = []; const codes: string[] = []; const statuses: number[] = [];
  const seen = new Set<object>(); let runtimeName = '';
  for (let i = 0; i < queue.length && i < 20; i++) {
    const { value, depth } = queue[i]!;
    if (typeof value === 'string') {
      if (value.length > 8192) continue;
      messages.push(value);
      try { if (depth < 3) queue.push({ value: JSON.parse(value), depth: depth + 1 }); } catch { /* Plain error text. */ }
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); const v = value as Record<string, unknown>;
    if (['TypeError', 'ReferenceError', 'SyntaxError'].includes(String(v.name))) runtimeName = String(v.name).toUpperCase();
    for (const key of ['code', 'errorCode', 'errCode', 'Code', 'error']) {
      const raw = v[key];
      if (typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(raw)) codes.push(raw.toUpperCase());
      else if (typeof raw === 'number' && Number.isSafeInteger(raw)) codes.push(String(raw));
    }
    for (const key of ['statusCode', 'status']) if (typeof v[key] === 'number' && Number.isInteger(v[key]) && Number(v[key]) >= 400 && Number(v[key]) <= 599) statuses.push(Number(v[key]));
    if (depth < 3) for (const key of ['message', 'errMsg', 'error_description', 'msg', 'data', 'error', 'Error', 'cause', 'response']) {
      if (v[key] !== undefined) queue.push({ value: v[key], depth: depth + 1 });
    }
  }
  const detail = messages.join(' ').toLowerCase();
  if (detail.includes('domain list')) return 'REQUEST_DOMAIN';
  if (detail.includes('timeout') || detail.includes('timed out')) return 'TIMEOUT';
  if (codes.length) return codes[0]!;
  if (statuses.length) return `HTTP_${statuses[0]}`;
  if (detail.includes('network') || detail.includes('request:fail')) return 'NETWORK';
  if (detail.includes('not found') || detail.includes('not exist')) return 'FUNCTION_NOT_FOUND';
  if (detail.includes('permission') || detail.includes('forbidden')) return 'PERMISSION_DENIED';
  return runtimeName || 'UNKNOWN';
}
