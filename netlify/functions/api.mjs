import { getStore } from "@netlify/blobs";

const MAX_MB = 150;              // tamaño máximo por APK (igual que en index.html)
const CH = 3 * 1024 * 1024;      // trozos de 3 MB (Netlify Functions admite máx. 6 MB)
const MAX_N = Math.ceil((MAX_MB * 1024 * 1024) / CH);

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export default async (req) => {
  const u = new URL(req.url), q = u.searchParams;
  const p = u.pathname.replace(/^\/api\/?/, "").split("/");
  const m = getStore({ name: "meta", consistency: "strong" });
  const d = getStore({ name: "chunks", consistency: "strong" });
  const oc = Netlify.env.get("OWNER_CODE"); // el código de dueño vive SOLO en Netlify
  const owner = !!oc && req.headers.get("x-owner") === oc;

  try {
    if (p[0] === "list") {
      const { blobs } = await m.list();
      const all = await Promise.all(blobs.map((b) => m.get(b.key, { type: "json" })));
      return json(all.filter((x) => x && x.ok).map(({ tok, ...r }) => r).sort((a, b) => b.date - a.date));
    }

    if (p[0] === "owner") return json({ ok: owner }, owner ? 200 : 401);

    if (p[0] === "file") {
      const buf = await d.get(`${p[1]}/${p[2]}`, { type: "arrayBuffer" });
      return buf
        ? new Response(buf, { headers: { "content-type": "application/octet-stream" } })
        : json({ error: "No existe" }, 404);
    }

    if (p[0] === "chunk" && req.method === "POST") {
      const id = q.get("id") || "", tok = q.get("tok") || "";
      const i = +q.get("i"), n = +q.get("n");
      if (!/^[\w-]{20,60}$/.test(id) || tok.length < 20 || !(n >= 1 && n <= MAX_N) || !(i >= 0 && i < n))
        return json({ error: "Datos inválidos" }, 400);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > CH + 1024) return json({ error: "Trozo inválido" }, 400);

      let r = await m.get(id, { type: "json" });
      if (i === 0) {
        const name = String(q.get("name") || "").replace(/[<>"'\\/]/g, "").slice(0, 120);
        const h = new Uint8Array(buf); // un APK es un ZIP: empieza con "PK"
        if ((r && !(r.tok === tok && !r.ok)) || !/\.apk$/i.test(name) || h[0] !== 0x50 || h[1] !== 0x4b)
          return json({ error: "Solo se permiten archivos APK" }, 400);
        r = { id, name, n, tok, size: 0, date: Date.now(), ok: false };
        await m.setJSON(id, r);
      }
      if (!r || r.tok !== tok || r.n !== n) return json({ error: "No autorizado" }, 403);
      await d.set(`${id}/${i}`, buf);
      if (i === n - 1) {
        r.ok = true;
        r.size = (n - 1) * CH + buf.byteLength;
        await m.setJSON(id, r);
      }
      return json({ ok: true });
    }

    if (p[0] === "del" && req.method === "POST") {
      const { id, tok } = await req.json();
      const r = typeof id === "string" ? await m.get(id, { type: "json" }) : null;
      if (!r) return json({ error: "No existe" }, 404);
      if (!owner && r.tok !== tok) return json({ error: "No autorizado" }, 403);
      await Promise.all([...Array(r.n).keys()].map((i) => d.delete(`${id}/${i}`)));
      await m.delete(id);
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: "Error del servidor" }, 500);
  }
  return json({ error: "No encontrado" }, 404);
};

export const config = { path: "/api/*" };
