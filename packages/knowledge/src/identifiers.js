// Code is full of identifiers such as Customer_Order_API or CodeBHandling. A plain keyword
// search treats each as one long word, so a question about "customer order" would miss them.
// This returns the words hidden inside such identifiers, to be indexed next to the original text.

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const NEEDS_SPLITTING = /_|[a-z0-9][A-Z]|[A-Z]{2,}[a-z]/;
// Codes with punctuation inside: CAMT.053, ORA-20110, Customer_Order_API.Get_Objstate. PostgreSQL keeps
// such a code as one token (or cuts it oddly), so its parts are indexed as plain words as well.
// The lookbehind makes a match start only at the beginning of a run of letters and digits. Without it a very long run
// (base64 inside an XML file) is searched again from every position, which takes minutes.
const PUNCTUATED = /(?<![A-Za-z0-9_])[A-Za-z0-9_]+(?:[.\-/][A-Za-z0-9_]+)+/g;

export function splitIdentifiers(text, limit = 4000) {
  const words = new Set();

  for (const match of text.matchAll(IDENTIFIER)) {
    const id = match[0];
    if (!NEEDS_SPLITTING.test(id)) continue; // ordinary words need no help

    const parts = id
      .replace(/_/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // CodeBHandling -> Code BHandling
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // BHandling -> B Handling
      .toLowerCase()
      .split(/\s+/);

    for (const part of parts) if (part.length > 1 && !/^\d+$/.test(part)) words.add(part);
  }

  for (const match of text.matchAll(PUNCTUATED)) {
    for (const part of match[0].split(/[.\-/]/)) {
      if (part.length < 2) continue;
      words.add(part.toLowerCase());
      if (NEEDS_SPLITTING.test(part)) {
        for (const inner of splitIdentifiers(part, 200).split(" ")) if (inner) words.add(inner);
      }
    }
  }

  return [...words].join(" ").slice(0, limit);
}
