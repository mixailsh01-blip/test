export function unwrapPyrusData(raw) {
  if (
    raw &&
    typeof raw === "object" &&
    Object.prototype.hasOwnProperty.call(raw, "data") &&
    Object.prototype.hasOwnProperty.call(raw, "success")
  ) {
    return raw.data;
  }
  return raw;
}

export function createPyrusClient({ graphClient }) {
  if (!graphClient || typeof graphClient.callGraphApi !== "function") {
    throw new Error("graphClient is required for pyrusClient");
  }

  async function pyrusRequest(endpoint, payload = {}) {
    const method = payload.method || "GET";
    const body = payload.body || null;
    const requestPayload = { path: endpoint, method };
    if (body) requestPayload.body = body;
    return graphClient.callGraphApi("pyrus_api", requestPayload);
  }

  return { pyrusRequest };
}
