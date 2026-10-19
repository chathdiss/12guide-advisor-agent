// The IFS projection (REST/OData API) cards in the knowledge base (see packages/knowledge/src/projection-cards.js): one card per
// part of an API, with the endpoint, keys, fields and actions, and a link to the IFS API documentation.
export const API_ORIGIN = "IFS API documentation";

// A question about calling IFS over REST or OData: "How do I create a customer order through REST?", "Which action releases a
// customer order?", "What fields does the customer order entity set have?". These also get a search in the API cards alone, so a
// page of the general documentation does not push the real endpoint and field names out.
export const asksAboutApi = (text) =>
  /\b(rest|odata|endpoints?|projections?|entity ?sets?|api explorer|actions?|payloads?|request bod(?:y|ies)|json)\b|\$(?:filter|expand|select|orderby|top)\b/i.test(String(text ?? ""));
