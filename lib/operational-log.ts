// Error messages and stacks may embed stored contacts, SQL bindings or tokens.
// Keep only a fixed route label and a controlled category in diagnostics.
export function logOperationalError(route:string,error:unknown) {
  const category=error instanceof SyntaxError?"invalid-stored-format":error instanceof TypeError?"type-error":error instanceof RangeError?"range-error":"operation-error";
  console.error(JSON.stringify({event:"request_failed",route,category}));
}
