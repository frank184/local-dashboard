function normalizeLocalDateTime(value) {
  const local = String(value || '').trim();
  if (!Number.isFinite(new Date(local).getTime())) throw new Error('Enter a valid task due date and time.');
  return local.length === 16 ? `${local}:00` : local.slice(0, 19);
}

module.exports = { normalizeLocalDateTime };
