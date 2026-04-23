// Short-circuit OPTIONS preflight so extension/browser fetch succeeds.
// Response headers themselves come from vercel.json.
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
