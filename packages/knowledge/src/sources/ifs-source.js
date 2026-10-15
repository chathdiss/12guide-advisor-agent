import { readdir } from "node:fs/promises";
import path from "node:path";

// Source files that carry meaning. Left out on purpose:
//   .ins (installation data, huge), .resx (UI resource files), *.Designer.cs (generated form layout),
//   icons, project and solution files, scripts.
// IFS Cloud adds the model files of the Aurena web client and of the APIs: .entity, .projection, .client,
// .fragment, .enumeration and .utility.
const KEEP = new Set([
  ".plsql", ".plsvc", ".views", ".apv", ".cdb", ".cre", ".storage", ".upg", ".cs", ".csv", ".xml", ".java",
  ".entity", ".projection", ".client", ".fragment", ".enumeration", ".utility",
]);

const KIND = {
  ".plsql": "PL/SQL package",
  ".plsvc": "PL/SQL service",
  ".views": "database views",
  ".upg": "upgrade script",
  ".cre": "create script",
  ".cs": "C# client code",
  ".csv": "field descriptions",
  ".xml": "XML",
  ".java": "Java",
  ".entity": "entity model",
  ".projection": "projection (API)",
  ".client": "web client model",
  ".fragment": "model fragment",
  ".enumeration": "enumeration",
  ".utility": "utility model",
};

// Every version folder is its own source: Apps10_UPD29 -> "ifs-apps10-upd29", IFS_Cloud_25R2 -> "ifs-cloud-25r2"
export const sourceOf = (versionDir) => {
  const slug = String(versionDir).toLowerCase().replace(/_/g, "-");
  return slug.startsWith("ifs-") ? slug : `ifs-${slug}`;
};
export const ORIGIN = "IFS source code";

export function describeKind(ext) {
  return KIND[ext] ?? ext.slice(1);
}

// Yields one entry per useful file below `root`.
// Folder layout: <root>/<Version>/<component>/<layer>/.../<file>, e.g. Apps10_UPD29/accrul/database/X.plsql
export async function* walkIfsSource(root) {
  async function* walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!KEEP.has(ext)) continue;
      if (entry.name.toLowerCase().endsWith(".designer.cs")) continue;

      const rel = path.relative(root, full).split(path.sep);
      const [versionDir, component = "", layer = ""] = rel;
      yield {
        source: sourceOf(versionDir ?? ""),
        absPath: full,
        docKey: rel.join("/"),
        title: entry.name,
        ext,
        kind: describeKind(ext),
        version: (versionDir ?? "").replace(/_/g, " "),
        component: component.toUpperCase(),
        layer: rel.length > 3 ? layer : "",
      };
    }
  }
  yield* walk(root);
}
