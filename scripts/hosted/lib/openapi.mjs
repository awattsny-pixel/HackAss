/** The /rpc names an OpenAPI document lists, and anything else it lists besides the root. */
export function openApiSurface(doc) {
  const paths = Object.keys(doc?.paths ?? {});
  return { rpc: paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5)).sort(), other: paths.filter((p) => !p.startsWith('/rpc/') && p !== '/') };
}
