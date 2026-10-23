// Gives the consultant a file that the backend made (the export file of Option B). The content stays in the browser: it goes to no other address.
export type ExportFile = { name: string; mimeType: string; content: string; bytes: number };

type Doc = Pick<Document, "createElement" | "body">;
type Urls = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export function downloadFile(file: ExportFile, doc: Doc = document, urls: Urls = URL): void {
  const url = urls.createObjectURL(new Blob([file.content], { type: `${file.mimeType};charset=utf-8` }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = file.name;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  urls.revokeObjectURL(url);
}
