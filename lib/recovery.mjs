const id = /^[\w.-]{1,128}$/;

export async function recoverInference(client, action, args, sessionId) {
  const usage = 'Usage: recovery candidates <limited-provider> | recovery switch <session-id> <limited-provider> <provider/model>';
  if (action !== 'candidates' && action !== 'switch') throw new Error(usage);
  if (action === 'switch' && sessionId === undefined) [sessionId, ...args] = args;
  const [excluded, route] = args;
  if (!id.test(excluded ?? '') || args.length !== (action === 'candidates' ? 1 : 2) || (action === 'switch' && !sessionId)) throw new Error(usage);
  const parsed = action === 'switch' ? /^([\w.-]{1,128})\/([\w.-]{1,128})$/.exec(route) : null;
  if (action === 'switch' && (!parsed || parsed[1] === excluded)) throw new Error('Choose a different provider as provider/model');
  const { groups, routableProviders } = await client.modelCatalog();
  const routable = new Set(routableProviders);
  const candidates = (groups ?? []).filter(group => group.id !== excluded && routable.has(group.id));
  if (action === 'candidates') return { excluded, candidates: candidates.flatMap(g => (g.models ?? []).map(m => `${g.id}/${m.id}`)) };
  const [, provider, model] = parsed;
  if (!candidates.some(g => g.id === provider && g.models?.some(m => m.id === model))) throw new Error('Requested route is not in the routable catalog');
  await client.selectModel(sessionId, provider, model);
  return { sessionId, excluded, provider, model, promptResent: false };
}
