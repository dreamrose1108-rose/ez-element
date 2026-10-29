export function positiveMoneyFen(value: string, label: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`请填写${label}，最多两位小数`);
  const [yuan, decimal = ''] = value.split('.');
  const fen = Number(yuan) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(fen) || fen <= 0 || fen > 100000000) throw new Error(`${label}须大于 0 且不超过 100 万元`);
  return fen;
}
