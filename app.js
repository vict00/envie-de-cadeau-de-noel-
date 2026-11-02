(() => {
  "use strict";

  // ---------- Config ----------
  const cfg = { ...window.WISHLIST_CONFIG };
  const host = location.hostname;
  if (host.endsWith(".github.io")) {
    cfg.owner = host.replace(".github.io", "");
    const first = location.pathname.split("/").filter(Boolean)[0];
    if (first) cfg.repo = first;
  }
  const API = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.file}`;
  const TOKEN_KEY = "wishlist-token";

  const PROXIES = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];

  // ---------- State ----------
  let wishes = [];
  let sha = null;
  let pending = null;

  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $("grid"), empty: $("empty"), summary: $("summary"),
    addPanel: $("addPanel"), addForm: $("addForm"), urlInput: $("urlInput"), fetchBtn: $("fetchBtn"),
    preview: $("preview"), pvImage: $("pvImage"), pvTitle: $("pvTitle"), pvPrice: $("pvPrice"),
    pvImageUrl: $("pvImageUrl"), pvNote: $("pvNote"), pvCancel: $("pvCancel"), pvSave: $("pvSave"),
    sortSelect: $("sortSelect"), adminBtn: $("adminBtn"),
    tokenDialog: $("tokenDialog"), tokenInput: $("tokenInput"), tokenError: $("tokenError"), tokenSave: $("tokenSave"),
    toast: $("toast"),
  };

  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };
  const isAdmin = () => !!getToken();

  // ---------- Helpers ----------
  const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => els.toast.classList.remove("show"), msg.length > 60 ? 8000 : 3200);
  }

  function siteName(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\n/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  async function fetchWithTimeout(url, opts = {}, ms = 9000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  // "1 299,99 €" / "$1,299.99" / "29.9" -> number
  function parsePrice(raw) {
    if (raw == null) return null;
    if (typeof raw === "number") return raw > 0 ? raw : null;
    let s = String(raw).replace(/[^\d.,]/g, "");
    if (!s) return null;
    const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  // ---------- GitHub storage ----------
  async function loadWishes() {
    const headers = { Accept: "application/vnd.github+json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${API}?ref=${cfg.branch}&t=${Date.now()}`, { headers, cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      sha = data.sha;
      return JSON.parse(b64decode(data.content) || "[]");
    } catch {
      // Repli : la copie publiée par GitHub Pages (peut avoir ~1 min de retard)
      const res = await fetch(`${cfg.file}?t=${Date.now()}`, { cache: "no-store" });
      return res.ok ? res.json() : [];
    }
  }

  async function saveWishes(next, message) {
    const token = getToken();
    if (!token) throw new Error("Pas de jeton");
    // Récupère le sha le plus récent pour éviter les conflits
    const head = await fetch(`${API}?ref=${cfg.branch}&t=${Date.now()}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (head.ok) sha = (await head.json()).sha;
    const res = await fetch(API, {
      method: "PUT",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message,
        branch: cfg.branch,
        sha: sha || undefined,
        content: b64encode(JSON.stringify(next, null, 2) + "\n"),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 403 || res.status === 404)
        throw new Error("ton jeton n'a pas le droit d'écrire. Sur GitHub, donne-lui accès à ce dépôt avec « Contents : Read and write ».");
      if (res.status === 401) throw new Error("jeton invalide ou expiré.");
      throw new Error(err.message || `Erreur GitHub ${res.status}`);
    }
    sha = (await res.json()).content.sha;
    wishes = next;
    render();
  }

  // ---------- Product scraping ----------
  // Microlink récupère la page côté serveur (pas de souci CORS) et applique nos sélecteurs.
  const RULES = {
    ld: { selectorAll: 'script[type="application/ld+json"]', attr: "text" },
    metaPrice: { selector: 'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"]', attr: "content" },
    itemPrice: { selector: "[itemprop=price]", attr: "text" },
    shopPrice: {
      selector: "#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, #priceblock_ourprice, .a-price .a-offscreen, .f-faPriceBox__price, .fpPrice, [data-price]",
      attr: "text",
    },
    hiresImage: { selector: "#landingImage", attr: "data-old-hires" },
  };

  async function fetchMicrolink(url) {
    const q = new URLSearchParams({ url });
    for (const [name, rule] of Object.entries(RULES))
      for (const [k, v] of Object.entries(rule)) q.set(`data.${name}.${k}`, v);
    // Requête complète (avec le prix), puis requête simple (titre + image) en secours
    for (const query of [q, new URLSearchParams({ url })]) {
      try {
        const res = await fetchWithTimeout(`https://api.microlink.io/?${query}`, {}, 20000);
        const j = await res.json();
        if (j.status === "success") return j.data;
      } catch {}
    }
    return null;
  }

  async function fetchHtml(url) {
    for (const proxy of PROXIES) {
      try {
        const res = await fetchWithTimeout(proxy(url), {}, 6000);
        if (!res.ok) continue;
        const html = await res.text();
        if (html && html.length > 500) return html;
      } catch {}
    }
    return null;
  }

  function fromJsonLd(blocks) {
    const out = { title: null, image: null, prices: [] };
    for (let data of [].concat(blocks || [])) {
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { continue; } }
      for (const p of findProducts(data)) {
        out.title ||= p.name;
        const img = Array.isArray(p.image) ? p.image[0] : p.image;
        out.image ||= typeof img === "object" ? img?.url : img;
        for (const o of [].concat(p.offers || [])) {
          [o.price, o.lowPrice, o.highPrice, o.priceSpecification?.price]
            .map(parsePrice).filter(Boolean).forEach((v) => out.prices.push(v));
        }
      }
    }
    return out;
  }

  function findProducts(node, out = []) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) { node.forEach((n) => findProducts(n, out)); return out; }
    const type = [].concat(node["@type"] || []).map(String);
    if (type.some((t) => /product/i.test(t))) out.push(node);
    if (node["@graph"]) findProducts(node["@graph"], out);
    if (node.mainEntity) findProducts(node.mainEntity, out);
    return out;
  }

  function parseHtml(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const meta = (...names) => {
      for (const n of names) {
        const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
        const v = el && el.getAttribute("content");
        if (v) return v.trim();
      }
      return null;
    };
    const abs = (u) => { try { return u ? new URL(u, pageUrl).href : null; } catch { return null; } };

    const result = { title: null, image: null, prices: [] };

    const ld = fromJsonLd([...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent));
    Object.assign(result, ld);

    // Meta tags
    result.title ||= meta("og:title", "twitter:title") || doc.title;
    result.image ||= meta("og:image", "og:image:secure_url", "twitter:image");
    if (!result.prices.length) {
      const p = parsePrice(meta("product:price:amount", "og:price:amount", "price"));
      if (p) result.prices.push(p);
    }

    // Sélecteurs courants (Amazon, Fnac, Cdiscount, etc.)
    if (!result.image) {
      const im = doc.querySelector("#landingImage, #imgBlkFront, #main-image");
      result.image = im && (im.getAttribute("data-old-hires") || im.getAttribute("src"));
    }
    if (!result.prices.length) {
      const sel = [
        "#corePrice_feature_div .a-offscreen", "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#priceblock_ourprice", "#priceblock_dealprice", ".a-price .a-offscreen",
        "[itemprop=price]", ".f-faPriceBox__price", ".fpPrice", ".price", "[data-price]",
      ];
      for (const q of sel) {
        const el = doc.querySelector(q);
        const p = el && parsePrice(el.getAttribute("content") || el.getAttribute("data-price") || el.textContent);
        if (p) { result.prices.push(p); break; }
      }
    }

    result.title = result.title?.replace(/\s+/g, " ").trim() || null;
    result.image = abs(result.image);
    return result;
  }

  function fromMicrolink(d) {
    const ld = fromJsonLd(d.ld);
    if (!ld.prices.length) {
      const p = parsePrice(d.metaPrice) || parsePrice(d.itemPrice) || parsePrice(d.shopPrice);
      if (p) ld.prices.push(p);
    }
    return {
      title: ld.title || d.title || null,
      image: d.hiresImage || ld.image || d.image?.url || null,
      prices: ld.prices,
    };
  }

  async function scrapeProduct(url) {
    const micro = await fetchMicrolink(url);
    let found = micro ? fromMicrolink(micro) : { title: null, image: null, prices: [] };
    // Repli si Microlink n'a rien donné (quota atteint, site bloqué…)
    if (!found.prices.length || !found.image) {
      const html = await fetchHtml(url);
      if (html) {
        const parsed = parseHtml(html, url);
        found = {
          title: found.title || parsed.title,
          image: found.image || parsed.image,
          prices: found.prices.length ? found.prices : parsed.prices,
        };
      }
    }
    const uniq = [...new Set(found.prices)];
    const price = uniq.length ? Math.round((uniq.reduce((a, b) => a + b, 0) / uniq.length) * 100) / 100 : null;
    return {
      title: found.title?.replace(/\s+/g, " ").trim() || siteName(url),
      image: found.image || "",
      price,
      priceCount: uniq.length,
    };
  }

  // ---------- Render ----------
  function render() {
    const sorted = [...wishes];
    const mode = els.sortSelect.value;
    if (mode === "recent") sorted.sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
    if (mode === "price-asc") sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    if (mode === "price-desc") sorted.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));

    els.grid.replaceChildren(...sorted.map(card));
    els.empty.hidden = wishes.length > 0;

    const total = wishes.reduce((s, w) => s + (w.price || 0), 0);
    const n = wishes.length;
    els.summary.textContent = n
      ? `${n} envie${n > 1 ? "s" : ""} · environ ${eur.format(total)} au total`
      : "La liste est vide pour le moment";
  }

  function card(w) {
    const li = document.createElement("li");
    li.className = "card";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (w.image) {
      const img = document.createElement("img");
      img.src = w.image;
      img.alt = w.title || "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => img.replaceWith(placeholder());
      thumb.append(img);
    } else thumb.append(placeholder());

    const body = document.createElement("div");
    body.className = "body";
    const site = document.createElement("span");
    site.className = "site";
    site.textContent = siteName(w.url);
    const h3 = document.createElement("h3");
    h3.textContent = w.title || "Sans titre";
    h3.title = w.title || "";
    const price = document.createElement("div");
    price.className = "price" + (w.price ? "" : " unknown");
    price.textContent = w.price ? eur.format(w.price) : "Prix inconnu";

    const actions = document.createElement("div");
    actions.className = "actions";
    const a = document.createElement("a");
    a.className = "btn";
    a.href = w.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Voir ↗";
    actions.append(a);
    if (isAdmin()) {
      const edit = document.createElement("button");
      edit.className = "btn del";
      edit.title = "Modifier";
      edit.setAttribute("aria-label", "Modifier");
      edit.textContent = "✏️";
      edit.onclick = () => editWish(w);
      actions.append(edit);
      const del = document.createElement("button");
      del.className = "btn del";
      del.title = "Supprimer";
      del.setAttribute("aria-label", "Supprimer");
      del.textContent = "🗑";
      del.onclick = () => removeWish(w.id, del);
      actions.append(del);
    }

    body.append(site, h3, price, actions);
    li.append(thumb, body);
    return li;
  }

  function placeholder() {
    const s = document.createElement("span");
    s.className = "placeholder";
    s.textContent = "🎁";
    return s;
  }

  // ---------- Actions ----------
  async function removeWish(id, btn) {
    const w = wishes.find((x) => x.id === id);
    if (!w || !confirm(`Supprimer « ${w.title} » ?`)) return;
    btn.disabled = true;
    try {
      await saveWishes(wishes.filter((x) => x.id !== id), `Supprime : ${w.title}`);
      toast("Envie supprimée");
    } catch (e) {
      btn.disabled = false;
      toast("Échec : " + e.message);
    }
  }

  function editWish(w) {
    pending = { ...w, editing: true };
    els.urlInput.value = w.url;
    showPreview({ ...w, priceCount: 0 });
    els.pvNote.textContent = "Modification de l'envie.";
    els.addPanel.scrollIntoView({ behavior: "smooth" });
  }

  function showPreview(data) {
    els.pvTitle.value = data.title || "";
    els.pvPrice.value = data.price ?? "";
    els.pvImageUrl.value = data.image || "";
    els.pvImage.src = data.image || "";
    els.pvImage.hidden = !data.image;
    const notes = [];
    if (!data.price) notes.push("Prix introuvable automatiquement, tu peux le saisir.");
    else if (data.priceCount > 1) notes.push(`Prix moyen calculé sur ${data.priceCount} offres.`);
    if (!data.image) notes.push("Pas d'image trouvée, tu peux coller un lien d'image.");
    els.pvNote.textContent = notes.join(" ");
    els.preview.hidden = false;
  }

  function resetAdd() {
    pending = null;
    els.preview.hidden = true;
    els.addForm.reset();
  }

  els.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = els.urlInput.value.trim();
    if (!url) return;
    els.fetchBtn.disabled = true;
    els.fetchBtn.textContent = "Recherche…";
    try {
      const data = await scrapeProduct(url);
      pending = { url, ...data };
      showPreview(data);
    } finally {
      els.fetchBtn.disabled = false;
      els.fetchBtn.textContent = "Ajouter";
    }
  });

  els.pvImageUrl.addEventListener("input", () => {
    els.pvImage.src = els.pvImageUrl.value;
    els.pvImage.hidden = !els.pvImageUrl.value;
  });
  els.pvCancel.addEventListener("click", resetAdd);

  els.pvSave.addEventListener("click", async () => {
    if (!pending) return;
    const fields = {
      url: els.urlInput.value.trim() || pending.url,
      title: els.pvTitle.value.trim() || siteName(pending.url),
      image: els.pvImageUrl.value.trim(),
      price: parsePrice(els.pvPrice.value),
    };
    const editing = pending.editing;
    const next = editing
      ? wishes.map((w) => (w.id === pending.id ? { ...w, ...fields } : w))
      : [...wishes, { id: crypto.randomUUID?.() || String(Date.now()), ...fields, addedAt: new Date().toISOString() }];
    els.pvSave.disabled = true;
    try {
      await saveWishes(next, `${editing ? "Modifie" : "Ajoute"} : ${fields.title}`);
      resetAdd();
      toast(editing ? "Envie modifiée" : "Envie ajoutée 🎄");
    } catch (e) {
      toast("Échec : " + e.message);
    } finally {
      els.pvSave.disabled = false;
    }
  });

  els.sortSelect.addEventListener("change", render);

  // Le mode gestion n'apparaît que via le lien secret …/?admin (ou une fois le jeton enregistré)
  const adminLink = new URLSearchParams(location.search).has("admin");

  function updateAdminUi() {
    els.addPanel.hidden = !isAdmin();
    els.adminBtn.hidden = !isAdmin() && !adminLink;
    els.adminBtn.textContent = isAdmin() ? "🔒 Quitter le mode gestion" : "🔑 Gérer ma liste";
    render();
  }

  function askToken() {
    els.tokenError.textContent = "";
    els.tokenInput.value = "";
    els.tokenDialog.showModal();
  }

  els.adminBtn.addEventListener("click", () => {
    if (isAdmin()) { setToken(null); updateAdminUi(); toast("Mode gestion désactivé"); return; }
    askToken();
  });

  els.tokenSave.addEventListener("click", async (e) => {
    e.preventDefault();
    const t = els.tokenInput.value.trim();
    if (!t) return;
    els.tokenSave.disabled = true;
    try {
      const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${t}` },
      });
      const repo = await res.json();
      if (!res.ok) throw new Error(repo.message || "Jeton invalide");
      if (repo.permissions && !repo.permissions.push) throw new Error("Ce jeton n'a pas le droit d'écrire sur le dépôt");
      setToken(t);
      els.tokenDialog.close();
      updateAdminUi();
      toast("Mode gestion activé");
    } catch (err) {
      els.tokenError.textContent = err.message;
    } finally {
      els.tokenSave.disabled = false;
    }
  });

  // ---------- Init ----------
  (async () => {
    try { wishes = await loadWishes(); }
    catch { wishes = []; }
    updateAdminUi();
    if (adminLink && !isAdmin()) askToken();
  })();
})();
