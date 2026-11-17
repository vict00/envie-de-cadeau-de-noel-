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
    pvPriceLabel: $("pvPriceLabel"), pvText: $("pvText"), pvTextLabel: $("pvTextLabel"), pvStars: $("pvStars"),
    pvEmoji: $("pvEmoji"), pvEmojiPreview: $("pvEmojiPreview"),
    lotForm: $("lotForm"), lotUrl: $("lotUrl"), lotAddBtn: $("lotAddBtn"), lotItems: $("lotItems"),
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
  const kindOf = (w) => w.kind || "product";

  function render() {
    const sorted = [...wishes];
    const mode = els.sortSelect.value;
    const recent = (a, b) => (b.addedAt || "").localeCompare(a.addedAt || "");
    if (mode === "rating") sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0) || recent(a, b));
    if (mode === "recent") sorted.sort(recent);
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

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function image(src, alt) {
    const img = el("img");
    img.src = src;
    img.alt = alt || "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.replaceWith(placeholder());
    return img;
  }

  function stars(rating) {
    const s = el("div", "stars", "★".repeat(rating) + "☆".repeat(5 - rating));
    s.setAttribute("aria-label", `Importance : ${rating} sur 5`);
    return s;
  }

  function card(w) {
    const kind = kindOf(w);
    const li = el("li", `card kind-${kind}` + (w.rating === 5 ? " top" : ""));
    if (w.rating === 5) li.append(el("span", "ribbon", "❤️ Très envie"));

    // Visuel
    const thumb = el("div", "thumb");
    if (kind === "lot") {
      const imgs = (w.items || []).filter((i) => i.image).slice(0, 4);
      if (imgs.length) {
        thumb.classList.add("mosaic", `n${imgs.length}`);
        imgs.forEach((i) => thumb.append(image(i.image, i.title)));
      } else thumb.append(placeholder("📦"));
      thumb.append(el("span", "badge", `Lot de ${(w.items || []).length}`));
    } else if (kind === "perso") {
      thumb.append(el("span", "placeholder big", w.emoji || "💶"));
    } else {
      thumb.append(w.image ? image(w.image, w.title) : placeholder());
    }

    // Texte
    const body = el("div", "body");
    body.append(el("span", "site", kind === "perso" ? "Perso" : kind === "lot" ? "Lot" : siteName(w.url)));
    const h3 = el("h3", null, w.title || "Sans titre");
    h3.title = w.title || "";
    body.append(h3);
    if (w.rating) body.append(stars(w.rating));
    if (w.note) {
      const note = el("p", "note");
      if (kind === "perso") note.append(el("strong", null, "Pourquoi : "));
      note.append(w.note);
      body.append(note);
    }

    if (kind === "lot" && w.items?.length) {
      const list = el("ul", "lot-list");
      for (const it of w.items) {
        const item = el("li");
        const a = el("a", null, it.title || siteName(it.url));
        a.href = it.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        item.append(a);
        if (it.price) item.append(el("span", null, eur.format(it.price)));
        list.append(item);
      }
      body.append(list);
    }

    // Prix
    const price = el("div", "price" + (w.price ? "" : " unknown"));
    if (w.price) {
      price.append(eur.format(w.price));
      const itemsSum = kind === "lot" ? (w.items || []).reduce((s, i) => s + (i.price || 0), 0) : 0;
      if (itemsSum > w.price + 0.01) price.append(" ", el("s", "was", eur.format(itemsSum)));
    } else price.textContent = kind === "perso" ? "Montant libre" : "Prix inconnu";
    body.append(price);

    // Boutons
    const actions = el("div", "actions");
    if (kind === "product" && w.url) {
      const a = el("a", "btn", "Voir ↗");
      a.href = w.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      actions.append(a);
    }
    if (isAdmin()) {
      const edit = el("button", "btn del", "✏️");
      edit.title = "Modifier";
      edit.setAttribute("aria-label", "Modifier");
      edit.onclick = () => editWish(w);
      const del = el("button", "btn del", "🗑");
      del.title = "Supprimer";
      del.setAttribute("aria-label", "Supprimer");
      del.onclick = () => removeWish(w.id, del);
      actions.append(edit, del);
    }
    if (actions.children.length) body.append(actions);

    li.append(thumb, body);
    return li;
  }

  function placeholder(emoji = "🎁") {
    return el("span", "placeholder", emoji);
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

  // ---------- Éditeur (article / lot / perso) ----------
  let kind = "product";
  let rating = 0;
  let lotPriceTouched = false;

  const LABELS = {
    product: { price: "Prix (€)", text: "Note (taille, couleur…)", placeholder: "" },
    lot: { price: "Prix du lot (€)", text: "Détail de l'offre", placeholder: "ex : 1 acheté = 1 offert" },
    perso: { price: "Montant (€)", text: "Pourquoi ?", placeholder: "ex : pour mon permis, un voyage…" },
  };

  // Affiche les éléments dont data-for contient le type choisi
  function showFor(k) {
    els.addPanel.querySelectorAll("[data-for]").forEach((e) => {
      e.hidden = !e.dataset.for.split(" ").includes(k);
    });
  }

  function setKind(k) {
    kind = k;
    els.addPanel.querySelectorAll(".kind-tab").forEach((t) => t.classList.toggle("active", t.dataset.kind === k));
    showFor(k);
    els.pvPriceLabel.textContent = LABELS[k].price;
    els.pvTextLabel.textContent = LABELS[k].text;
    els.pvText.placeholder = LABELS[k].placeholder;
  }

  function renderStars() {
    els.pvStars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
      const b = el("button", "star" + (n <= rating ? " on" : ""), n <= rating ? "★" : "☆");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(n === rating));
      b.setAttribute("aria-label", `${n} sur 5`);
      b.onclick = () => { rating = rating === n ? 0 : n; renderStars(); };
      return b;
    }));
  }

  function setImage(src) {
    els.pvImage.src = src || "";
    els.pvImage.hidden = kind !== "product" || !src;
  }

  function renderLotItems() {
    const items = pending?.items || [];
    els.lotItems.replaceChildren(...items.map((it, i) => {
      const li = el("li");
      li.append(it.image ? image(it.image, it.title) : placeholder());
      const title = el("input");
      title.value = it.title || "";
      title.oninput = () => (it.title = title.value);
      const price = el("input");
      price.type = "number";
      price.step = "0.01";
      price.min = "0";
      price.placeholder = "Prix";
      price.value = it.price ?? "";
      price.oninput = () => { it.price = parsePrice(price.value); syncLotPrice(); };
      const rm = el("button", "btn del", "✕");
      rm.type = "button";
      rm.setAttribute("aria-label", "Retirer du lot");
      rm.onclick = () => { items.splice(i, 1); renderLotItems(); syncLotPrice(); };
      li.append(title, price, rm);
      return li;
    }));
    if (!items.length) els.lotItems.append(el("li", "lot-empty", "Ajoute les liens des articles du lot ci-dessus."));
  }

  // Par défaut le prix du lot = somme des articles (modifiable, ex. 1 acheté 1 offert)
  function syncLotPrice() {
    if (lotPriceTouched) return;
    const sum = (pending?.items || []).reduce((s, i) => s + (i.price || 0), 0);
    els.pvPrice.value = sum ? Math.round(sum * 100) / 100 : "";
  }

  function openEditor(data, hint = "") {
    pending = { ...data, items: data.items ? data.items.map((i) => ({ ...i })) : [] };
    setKind(kindOf(data));
    els.pvTitle.value = data.title || "";
    els.pvPrice.value = data.price ?? "";
    els.pvImageUrl.value = data.image || "";
    els.pvEmoji.value = data.emoji || "💶";
    els.pvEmojiPreview.textContent = els.pvEmoji.value;
    els.pvText.value = data.note || "";
    els.pvTitle.placeholder = kind === "lot" ? "ex : Lot de chargeurs" : kind === "perso" ? "ex : De l'argent" : "";
    rating = data.rating || 0;
    lotPriceTouched = kind === "lot" && data.price != null;
    setImage(data.image);
    renderStars();
    renderLotItems();
    els.pvNote.textContent = hint;
    els.preview.hidden = false;
  }

  function resetAdd() {
    pending = null;
    els.preview.hidden = true;
    els.addForm.reset();
    els.lotForm.reset();
    setKind("product");
  }

  function editWish(w) {
    els.urlInput.value = w.url || "";
    openEditor({ ...w, editing: true }, "Modification de l'envie.");
    els.addPanel.scrollIntoView({ behavior: "smooth" });
  }

  els.addPanel.querySelectorAll(".kind-tab").forEach((t) => {
    t.addEventListener("click", () => {
      const k = t.dataset.kind;
      if (pending?.editing && !confirm("Abandonner la modification en cours ?")) return;
      resetAdd();
      setKind(k);
      if (k !== "product") openEditor({ kind: k });
    });
  });

  els.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = els.urlInput.value.trim();
    if (!url) return;
    els.fetchBtn.disabled = true;
    els.fetchBtn.textContent = "Recherche…";
    try {
      const data = await scrapeProduct(url);
      const keep = pending?.editing ? { editing: true, id: pending.id, addedAt: pending.addedAt, note: els.pvText.value, rating } : {};
      const notes = [];
      if (!data.price) notes.push("Prix introuvable automatiquement, tu peux le saisir.");
      else if (data.priceCount > 1) notes.push(`Prix moyen calculé sur ${data.priceCount} offres.`);
      if (!data.image) notes.push("Pas d'image trouvée, tu peux coller un lien d'image.");
      openEditor({ ...keep, kind: "product", url, title: data.title, image: data.image, price: data.price }, notes.join(" "));
    } finally {
      els.fetchBtn.disabled = false;
      els.fetchBtn.textContent = "Ajouter";
    }
  });

  els.lotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = els.lotUrl.value.trim();
    if (!url || !pending) return;
    els.lotAddBtn.disabled = true;
    els.lotAddBtn.textContent = "Recherche…";
    try {
      const data = await scrapeProduct(url);
      pending.items.push({ url, title: data.title, image: data.image, price: data.price });
      els.lotForm.reset();
      renderLotItems();
      syncLotPrice();
      els.pvNote.textContent = data.price ? "" : "Prix d'un article introuvable, tu peux le saisir dans la liste.";
    } finally {
      els.lotAddBtn.disabled = false;
      els.lotAddBtn.textContent = "+ Au lot";
    }
  });

  els.pvPrice.addEventListener("input", () => { if (kind === "lot") lotPriceTouched = true; });
  els.pvImageUrl.addEventListener("input", () => setImage(els.pvImageUrl.value));
  els.pvEmoji.addEventListener("input", () => (els.pvEmojiPreview.textContent = els.pvEmoji.value || "💶"));
  els.pvCancel.addEventListener("click", resetAdd);

  function collectFields() {
    const common = {
      kind,
      title: els.pvTitle.value.trim(),
      price: parsePrice(els.pvPrice.value),
      note: els.pvText.value.trim() || undefined,
      rating: rating || undefined,
    };
    if (kind === "product") {
      const url = els.urlInput.value.trim() || pending.url;
      return { ...common, url, title: common.title || siteName(url), image: els.pvImageUrl.value.trim() };
    }
    if (kind === "lot") {
      const items = pending.items.filter((i) => i.url);
      if (!items.length) throw new Error("ajoute au moins un article au lot.");
      return { ...common, title: common.title || `Lot de ${items.length} articles`, items };
    }
    if (!common.title) throw new Error("donne un nom à cette envie.");
    return { ...common, emoji: els.pvEmoji.value.trim() || "💶" };
  }

  els.pvSave.addEventListener("click", async () => {
    if (!pending) return;
    let fields;
    try { fields = collectFields(); } catch (e) { toast("Oups : " + e.message); return; }
    const editing = pending.editing;
    const next = editing
      ? wishes.map((w) => (w.id === pending.id ? { id: w.id, addedAt: w.addedAt, ...fields } : w))
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
