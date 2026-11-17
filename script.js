const menuToggle = document.querySelector(".menu-toggle");
const mainNav = document.querySelector(".main-nav");
const toast = document.querySelector(".toast");
let toastTimer;
const cartStorageKey = "gleam-glow-cart";
const currency = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });
let cart = [];
const productStock = new Map();

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function loadCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(cartStorageKey) || "[]");
    if (!Array.isArray(stored)) throw new Error("Formato de carrinho inválido.");
    return stored.filter(item =>
      item && typeof item.id === "string" && typeof item.name === "string" &&
      typeof item.detail === "string" && typeof item.image === "string" &&
      Number.isFinite(item.price) && Number.isInteger(item.quantity) && item.quantity > 0
    );
  } catch (error) {
    showToast("Não foi possível carregar o carrinho guardado.");
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(cartStorageKey, JSON.stringify(cart));
  } catch (error) {
    showToast("Não foi possível guardar o carrinho neste dispositivo.");
  }
}

function cartSubtotal() {
  return cart.reduce((total, item) => total + item.price * item.quantity, 0);
}

function shippingCost(subtotal) {
  return subtotal === 0 || subtotal > 75 ? 0 : 4.9;
}

function formatStock(stock) {
  return stock === 1 ? "1 unidade disponível" : `${stock} unidades disponíveis`;
}

function updateProductStockDisplay(card, stock) {
  card.dataset.stock = String(stock);
  const stockMessage = card.querySelector(".product-stock");
  if (stockMessage) stockMessage.textContent = stock > 0 ? formatStock(stock) : "Esgotado";
  const addButton = card.querySelector(".add-to-cart");
  if (addButton) {
    addButton.disabled = stock === 0;
    addButton.textContent = stock > 0 ? "Adicionar ao carrinho" : "Indisponível";
  }
  const tag = card.querySelector(".product-tag");
  if (stock === 0 && !tag) {
    card.querySelector(".product-photo").insertAdjacentHTML("beforeend", '<span class="product-tag">Esgotado</span>');
  } else if (stock > 0 && tag) {
    tag.remove();
  }
}

async function getAvailableStock(products) {
  const stock = new Map(products.map(product => [product.id, product.stock]));
  if (!products.length) return stock;

  const { data, error } = await supabaseClient.rpc("get_available_product_stock", {
    p_product_ids: products.map(product => product.id)
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      console.warn("A migração de reservas ainda não está instalada; usa-se products.stock até lá.");
      return stock;
    }
    console.error("Não foi possível consultar a disponibilidade reservada:", error.message);
    return null;
  }
  if (!Array.isArray(data)) {
    console.error("A resposta do stock disponível tem um formato inválido.");
    return null;
  }
  if (data.length !== products.length) {
    console.error("A consulta de stock disponível não devolveu todos os produtos.");
    return null;
  }
  for (const item of data) {
    if (!stock.has(item.product_id) || !Number.isInteger(item.available_stock) || item.available_stock < 0) {
      console.error("A resposta de stock contém um produto ou valor inválido.");
      return null;
    }
    stock.set(item.product_id, item.available_stock);
  }
  return stock;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function loadCollectionProducts() {
  const collection = document.querySelector(".collection-page[data-category]");
  if (!collection) return;

  const grid = collection.querySelector(".product-grid");
  if (typeof supabaseClient === "undefined") {
    console.error("O cliente Supabase não está disponível.");
    grid.innerHTML = '<p class="product-grid-message">Não foi possível ligar ao catálogo. Tente novamente mais tarde.</p>';
    return;
  }
  const category = collection.dataset.category;
  grid.setAttribute("aria-busy", "true");
  grid.innerHTML = '<p class="product-grid-message">A carregar produtos...</p>';

  const { data, error } = await supabaseClient
    .from("products")
    .select("id, name, description, price_cents, category, stock, image_url")
    .eq("category", category)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  grid.removeAttribute("aria-busy");
  if (error) {
    console.error("Não foi possível carregar os produtos:", error.message);
    grid.innerHTML = '<p class="product-grid-message">Não foi possível carregar os produtos. Tente novamente mais tarde.</p>';
    return;
  }

  if (!data.length) {
    grid.innerHTML = '<p class="product-grid-message">Ainda não existem produtos disponíveis nesta coleção.</p>';
    return;
  }

  const { data: imageRows, error: imageError } = await supabaseClient
    .from("product_images")
    .select("id, product_id, image_url, sort_order, is_cover")
    .in("product_id", data.map(product => product.id))
    .order("sort_order", { ascending: true });

  if (imageError) {
    console.error("Não foi possível carregar as galerias; será usada a imagem compatível do produto:", imageError.message);
  }
  const imagesByProduct = new Map();
  for (const image of imageRows || []) {
    if (!imagesByProduct.has(image.product_id)) imagesByProduct.set(image.product_id, []);
    imagesByProduct.get(image.product_id).push(image);
  }

  const availableStock = await getAvailableStock(data);
  if (!availableStock) {
    grid.innerHTML = '<p class="product-grid-message">Não foi possível confirmar a disponibilidade dos produtos. Tenta novamente mais tarde.</p>';
    return;
  }

  grid.innerHTML = data.map(product => {
    const stock = availableStock.get(product.id) ?? 0;
    productStock.set(product.id, stock);
    const name = escapeHTML(product.name);
    const description = escapeHTML(product.description || "");
    const gallery = imagesByProduct.get(product.id) || [];
    if (product.image_url && !gallery.some(image => image.image_url === product.image_url)) {
      gallery.unshift({
        id: `legacy-${product.id}`,
        product_id: product.id,
        image_url: product.image_url,
        sort_order: -1,
        is_cover: true
      });
    }
    const cover = gallery.find(image => image.is_cover) ||
      gallery.find(image => image.image_url === product.image_url) ||
      gallery[0];
    const images = cover ? [cover, ...gallery.filter(image => image.id !== cover.id)] : [];
    const image = cover ? escapeHTML(cover.image_url) : "";
    const stockMessage = stock > 0 ? "" : '<span class="product-tag">Esgotado</span>';
    const photo = image
      ? `<button class="gallery-trigger product-main-image" type="button" data-gallery-id="${escapeHTML(product.id)}" data-full-src="${image}" data-caption="${name}"><img src="${image}" alt="${name}" loading="lazy"></button>
        ${images.length > 1 ? `<div class="product-thumbnails" aria-label="Fotografias de ${name}">${images.map((item, index) => {
          const imageURL = escapeHTML(item.image_url);
          return `<button class="gallery-trigger product-thumbnail ${index === 0 ? "is-current" : ""}" type="button" data-gallery-id="${escapeHTML(product.id)}" data-full-src="${imageURL}" data-caption="${name}" aria-label="Ver fotografia ${index + 1} de ${name}" aria-pressed="${index === 0}"><img src="${imageURL}" alt="" loading="lazy"></button>`;
        }).join("")}</div>` : ""}`
      : `<div class="product-image-placeholder" role="img" aria-label="Imagem não disponível"></div>`;

    return `<article class="product-card" data-product-id="${escapeHTML(product.id)}" data-price-cents="${product.price_cents}" data-stock="${stock}">
      <div class="product-photo">${photo}${stockMessage}</div>
      <div class="product-info"><div><h2 class="product-name">${name}</h2><p class="product-detail">${description}</p></div><p class="product-price">${currency.format(product.price_cents / 100)}</p></div>
      <div class="product-actions"><p class="product-stock" aria-live="polite">${stock > 0 ? formatStock(stock) : "Esgotado"}</p><button class="add-to-cart" type="button" ${stock > 0 ? "" : "disabled"}>${stock > 0 ? "Adicionar ao carrinho" : "Indisponível"}</button></div>
    </article>`;
  }).join("");
}

document.addEventListener("click", event => {
  const thumbnail = event.target.closest(".product-thumbnail");
  if (!thumbnail) return;
  const card = thumbnail.closest(".product-card");
  const mainImageButton = card.querySelector(".product-main-image");
  const mainImage = mainImageButton.querySelector("img");
  mainImage.src = thumbnail.dataset.fullSrc;
  mainImageButton.dataset.fullSrc = thumbnail.dataset.fullSrc;
  card.querySelectorAll(".product-thumbnail").forEach(button => {
    const current = button === thumbnail;
    button.classList.toggle("is-current", current);
    button.setAttribute("aria-pressed", String(current));
  });
});

function renderCheckout() {
  const items = document.querySelector(".checkout-items");
  if (!items) return;
  items.innerHTML = cart.length ? cart.map(item => `
    <article class="checkout-item">
      ${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : '<div class="cart-image-placeholder" aria-hidden="true"></div>'}
      <div><h3>${escapeHTML(item.name)}</h3><p>${escapeHTML(item.detail)}</p><span>Quantidade: ${item.quantity}</span></div>
      <strong>${currency.format(item.price * item.quantity)}</strong>
    </article>`).join("") : '<p class="checkout-empty">Ainda não adicionaste produtos ao carrinho.</p>';
  const subtotal = cartSubtotal();
  const shipping = shippingCost(subtotal);
  document.querySelector(".checkout-subtotal").textContent = currency.format(subtotal);
  document.querySelector(".checkout-shipping").textContent =
    shipping === 0 ? (subtotal > 75 ? "Grátis" : "—") : currency.format(shipping);
  document.querySelector(".checkout-total").textContent = currency.format(subtotal + shipping);
  const submitButton = document.querySelector(".checkout-submit");
  if (submitButton) submitButton.disabled = cart.length === 0;
}

function renderCart() {
  const count = cart.reduce((total, item) => total + item.quantity, 0);
  document.querySelectorAll(".cart-count").forEach(element => {
    element.textContent = String(count);
    element.hidden = count === 0;
  });
  const items = document.querySelector(".cart-popover-items");
  if (items) {
    items.innerHTML = cart.map(item => `
      <article class="cart-popover-item">
        ${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : '<div class="cart-image-placeholder" aria-hidden="true"></div>'}
        <div class="cart-popover-info">
          <h3>${escapeHTML(item.name)}</h3><p>${escapeHTML(item.detail)}</p>
          <div class="cart-popover-controls">
            <button type="button" data-cart-action="decrease" data-cart-id="${escapeHTML(item.id)}" aria-label="Diminuir quantidade de ${escapeHTML(item.name)}">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-cart-action="increase" data-cart-id="${escapeHTML(item.id)}" aria-label="Aumentar quantidade de ${escapeHTML(item.name)}" ${productStock.has(item.id) && item.quantity >= productStock.get(item.id) ? "disabled" : ""}>+</button>
            <button class="cart-remove" type="button" data-cart-action="remove" data-cart-id="${escapeHTML(item.id)}">Apagar</button>
          </div>
          ${productStock.has(item.id) ? `<p class="cart-stock">${escapeHTML(productStock.get(item.id) > 0 ? formatStock(productStock.get(item.id)) : "Esgotado")}</p>` : ""}
          <p class="cart-popover-price">${currency.format(item.price)} · Total ${currency.format(item.price * item.quantity)}</p>
        </div>
      </article>`).join("");
    document.querySelector(".cart-popover-empty").hidden = cart.length > 0;
    items.hidden = cart.length === 0;
    document.querySelector(".cart-popover-total").textContent = currency.format(cartSubtotal());
    document.querySelector(".cart-checkout").hidden = cart.length === 0;
  }
  renderCheckout();
}

async function updateCart(id, action) {
  const index = cart.findIndex(item => item.id === id);
  if (index < 0) return;
  if (action === "increase") {
    if (typeof supabaseClient === "undefined") {
      showToast("Não foi possível confirmar o stock. Tenta novamente.");
      return;
    }
    const { data, error } = await supabaseClient
        .from("products")
        .select("id, name, description, price_cents, stock, image_url, is_active")
        .eq("id", id)
        .eq("is_active", true)
        .maybeSingle();
    if (error) {
      console.error("Não foi possível confirmar o stock do produto:", error.message);
      showToast("Não foi possível confirmar o stock. Tenta novamente.");
      return;
    }
    if (!data) {
      console.error("O produto deixou de estar disponível:", id);
      showToast(`${cart[index].name} já não está disponível.`);
      cart.splice(index, 1);
      saveCart();
      renderCart();
      return;
    }
    const availableStock = await getAvailableStock([data]);
    if (!availableStock) {
      showToast("Não foi possível confirmar a disponibilidade. Tenta novamente.");
      return;
    }
    const stock = availableStock.get(id) ?? 0;
    const currentIndex = cart.findIndex(item => item.id === id);
    if (currentIndex < 0) return;
    productStock.set(id, stock);
    cart[currentIndex].name = data.name;
    cart[currentIndex].detail = data.description || "";
    cart[currentIndex].price = data.price_cents / 100;
    cart[currentIndex].image = data.image_url || "";
    saveCart();
    if (stock === 0 || cart[currentIndex].quantity > stock) {
      const name = data.name;
      if (stock === 0) {
        cart.splice(currentIndex, 1);
        saveCart();
      } else {
        cart[currentIndex].quantity = stock;
        saveCart();
      }
      showToast(stock > 0
        ? `A quantidade de ${name} foi ajustada para o stock disponível.`
        : `${name} está esgotado; foi removido do carrinho.`);
      renderCart();
      return;
    }
    if (cart[currentIndex].quantity === stock) {
      showToast(`Já atingiste o stock disponível de ${data.name}.`);
      renderCart();
      return;
    }
  }
  if (action === "remove" || (action === "decrease" && cart[index].quantity === 1)) cart.splice(index, 1);
  else if (action === "increase") cart[index].quantity += 1;
  else if (action === "decrease") cart[index].quantity -= 1;
  saveCart();
  renderCart();
}

async function refreshCartStock({ notify = true } = {}) {
  if (!cart.length) return { valid: true, changed: false };
  if (typeof supabaseClient === "undefined") {
    return { valid: false, error: "Não foi possível ligar ao catálogo para confirmar o stock." };
  }

  const ids = [...new Set(cart.map(item => item.id))];
  const { data, error } = await supabaseClient
    .from("products")
    .select("id, name, description, price_cents, stock, image_url, is_active")
    .in("id", ids)
    .eq("is_active", true);
  if (error) {
    console.error("Não foi possível confirmar o stock atual:", error.message);
    return { valid: false, error: "Não foi possível confirmar o stock atual. Tenta novamente." };
  }

  const availableStock = await getAvailableStock(data);
  if (!availableStock) {
    return { valid: false, error: "Não foi possível confirmar a disponibilidade do stock. Tenta novamente." };
  }
  const liveProducts = new Map(data.map(product => [product.id, product]));
  const problems = [];
  let changed = false;
  cart = cart.filter(item => {
    const product = liveProducts.get(item.id);
    if (!product) {
      problems.push(`${item.name}: produto indisponível.`);
      productStock.set(item.id, 0);
      changed = true;
      return false;
    }

    const stock = availableStock.get(product.id) ?? 0;
    productStock.set(product.id, stock);
    item.name = product.name;
    item.detail = product.description || "";
    item.price = product.price_cents / 100;
    item.image = product.image_url || "";
    if (stock === 0) {
      problems.push(`${product.name}: esgotado; foi removido do carrinho.`);
      changed = true;
      return false;
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > stock) {
      const previousQuantity = item.quantity;
      item.quantity = Math.max(1, Math.min(stock, Number.isInteger(previousQuantity) ? previousQuantity : 1));
      problems.push(`${product.name}: quantidade ajustada para ${item.quantity}, o máximo disponível.`);
      changed = true;
    }
    return true;
  });

  if (changed) saveCart();
  renderCart();
  if (notify && problems.length) showToast(problems.join(" "));
  return { valid: problems.length === 0, changed, problems };
}

function setupCart() {
  const button = document.querySelector('.header-actions [aria-label="Carrinho"]');
  const headerActions = document.querySelector(".header-actions");
  if (!button || !headerActions) return;
  button.removeAttribute("data-message");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "cart-popover");
  const popover = document.createElement("section");
  popover.id = "cart-popover";
  popover.className = "cart-popover";
  popover.setAttribute("aria-label", "Resumo do carrinho");
  popover.innerHTML = '<div class="cart-popover-heading"><h2>O teu carrinho</h2><button class="cart-popover-close" type="button" aria-label="Fechar carrinho">×</button></div><p class="cart-popover-empty">O seu carrinho está vazio.</p><div class="cart-popover-items"></div><div class="cart-popover-footer"><div class="cart-popover-total-row"><span>Subtotal</span><strong class="cart-popover-total">€ 0,00</strong></div><a class="button cart-checkout" href="checkout.html">Finalizar encomenda</a></div>';
  headerActions.append(popover);
  button.addEventListener("click", () => {
    const isOpen = popover.classList.toggle("open");
    button.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      refreshCartStock().then(result => {
        const stockMessage = document.querySelector(".checkout-stock-message");
        if (result.error) {
          showToast(result.error);
          if (stockMessage) stockMessage.textContent = result.error;
        } else if (result.problems?.length && stockMessage) {
          stockMessage.textContent = result.problems.join(" ");
        }
      });
    }
  });
  popover.querySelector(".cart-popover-close").addEventListener("click", () => {
    popover.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
    button.focus();
  });
  popover.addEventListener("click", event => {
    const control = event.target.closest("[data-cart-action]");
    if (control) updateCart(control.dataset.cartId, control.dataset.cartAction);
  });
  document.addEventListener("click", event => {
    if (!event.composedPath().includes(headerActions)) {
      popover.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && popover.classList.contains("open")) {
      popover.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
      button.focus();
    }
  });
}

if (menuToggle && mainNav) {
  menuToggle.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    menuToggle.setAttribute("aria-expanded", String(!isOpen));
    menuToggle.setAttribute("aria-label", isOpen ? "Abrir menu" : "Fechar menu");
    mainNav.classList.toggle("open", !isOpen);
  });

  mainNav.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => {
      mainNav.classList.remove("open");
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Abrir menu");
    });
  });
}

document.addEventListener("click", event => {
  const button = event.target.closest(".add-to-cart");
  if (button && !button.disabled) {
    const card = button.closest(".product-card");
    const id = card.dataset.productId;
    if (!id || typeof supabaseClient === "undefined") {
      showToast("Não foi possível confirmar o stock deste produto.");
      return;
    }
    button.disabled = true;
    supabaseClient
      .from("products")
      .select("id, name, description, price_cents, stock, image_url, is_active")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (error) {
          console.error("Não foi possível confirmar o produto antes de o adicionar:", error.message);
          showToast("Não foi possível confirmar o stock. Tenta novamente.");
          return;
        }
        if (!data) {
          console.error("O produto deixou de estar disponível:", id);
          updateProductStockDisplay(card, 0);
          showToast("Este produto já não está disponível.");
          return;
        }
        const availableStock = await getAvailableStock([data]);
        if (!availableStock) {
          showToast("Não foi possível confirmar a disponibilidade. Tenta novamente.");
          return;
        }
        const stock = availableStock.get(data.id) ?? 0;
        productStock.set(data.id, stock);
        updateProductStockDisplay(card, stock);
        const existing = cart.find(item => item.id === data.id);
        if (stock === 0) {
          if (existing) {
            cart = cart.filter(item => item.id !== data.id);
            saveCart();
            renderCart();
          }
          showToast(`${data.name} está esgotado.`);
          return;
        }
        if (existing && existing.quantity > stock) {
          existing.quantity = stock;
          existing.price = data.price_cents / 100;
          existing.name = data.name;
          existing.detail = data.description || "";
          existing.image = data.image_url || "";
          saveCart();
          renderCart();
          showToast(`${data.name}: quantidade ajustada para ${stock}, o máximo disponível.`);
          return;
        }
        if (existing && existing.quantity >= stock) {
          showToast(`Já atingiste o stock disponível de ${data.name}.`);
          return;
        }
        const item = {
          id: data.id,
          name: data.name,
          detail: data.description || "",
          image: card.querySelector(".product-photo img")?.getAttribute("src") || data.image_url || "",
          price: data.price_cents / 100
        };
        if (existing) {
          existing.quantity += 1;
          Object.assign(existing, item);
        } else {
          cart.push({ ...item, quantity: 1 });
        }
        saveCart();
        renderCart();
        showToast(`${data.name} adicionado ao carrinho.`);
      })
      .catch(error => {
        console.error("Falha ao confirmar o stock antes de adicionar ao carrinho:", error);
        showToast("Não foi possível confirmar o stock. Tenta novamente.");
      })
      .finally(() => {
        if (button.isConnected) button.disabled = Number(card.dataset.stock) === 0;
      });
  }
});

cart = loadCart();
setupCart();
renderCart();
refreshCartStock().then(result => {
  if (result.error) showToast(result.error);
});
loadCollectionProducts();

document.querySelectorAll("[data-message]").forEach(button => {
  button.addEventListener("click", () => showToast(button.dataset.message));
});

const checkoutForm = document.querySelector(".checkout-form");
if (checkoutForm) {
  checkoutForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!checkoutForm.reportValidity()) return;
    const stockMessage = document.querySelector(".checkout-stock-message");
    const submitButton = checkoutForm.querySelector(".checkout-submit");
    stockMessage.textContent = "";
    if (!cart.length) {
      stockMessage.textContent = "O carrinho está vazio.";
      return;
    }

    submitButton.disabled = true;
    const result = await refreshCartStock({ notify: false });
    submitButton.disabled = cart.length === 0;
    if (!result.valid) {
      stockMessage.textContent = result.error || result.problems.join(" ");
      return;
    }
    showToast("O pagamento ainda não está ligado. A tua encomenda não foi enviada.");
  });
}

const heroImage = document.querySelector(".hero-image");
if (heroImage) {
  const heroSlides = [
    {
      image: "https://images.unsplash.com/photo-1617038220319-276d3cfab638?auto=format&fit=crop&w=2200&q=88",
      alt: "Detalhe de joalharia dourada sobre pele ao sol",
      eyebrow: "Coleção de edição limitada",
      title: "Peças com<br>alma própria.",
      copy: "Pequenos detalhes. Grandes histórias."
    },
    {
      image: "https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=2200&q=88",
      alt: "Joias douradas com formas intemporais",
      eyebrow: "Essenciais de todos os dias",
      title: "O teu brilho,<br>à tua maneira.",
      copy: "Descobre peças feitas para ficar."
    },
    {
      image: "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=2200&q=88",
      alt: "Anel dourado em destaque",
      eyebrow: "Pequenas grandes histórias",
      title: "Guarda o que<br>te faz única.",
      copy: "Joias com significado, sempre contigo."
    }
  ];
  let activeSlide = 0;
  const heroEyebrow = document.querySelector(".hero .eyebrow");
  const heroTitle = document.querySelector(".hero h1");
  const heroCopy = document.querySelector(".hero-copy");
  const dots = [...document.querySelectorAll(".hero-dots button")];

  function showSlide(index) {
    activeSlide = (index + heroSlides.length) % heroSlides.length;
    const slide = heroSlides[activeSlide];
    heroImage.src = slide.image;
    heroImage.alt = slide.alt;
    heroEyebrow.textContent = slide.eyebrow;
    heroTitle.innerHTML = slide.title;
    heroCopy.textContent = slide.copy;
    dots.forEach((dot, dotIndex) => dot.setAttribute("aria-current", String(dotIndex === activeSlide)));
  }

  document.querySelector(".hero-arrow.prev").addEventListener("click", () => showSlide(activeSlide - 1));
  document.querySelector(".hero-arrow.next").addEventListener("click", () => showSlide(activeSlide + 1));
  dots.forEach((dot, index) => dot.addEventListener("click", () => showSlide(index)));
}

const newsletterForm = document.querySelector(".newsletter-form");
if (newsletterForm) {
  newsletterForm.addEventListener("submit", event => {
    event.preventDefault();
    const emailInput = event.currentTarget.elements.email;
    if (!emailInput.checkValidity()) {
      emailInput.reportValidity();
      return;
    }
    document.querySelector(".form-message").textContent = "Obrigada! Ficaste na nossa lista de novidades.";
    event.currentTarget.reset();
  });
}

const lightbox = document.querySelector(".photo-lightbox");
if (lightbox) {
  const lightboxImage = lightbox.querySelector(".lightbox-image");
  const lightboxCaption = lightbox.querySelector(".lightbox-caption");
  const previousButton = lightbox.querySelector(".lightbox-prev");
  const nextButton = lightbox.querySelector(".lightbox-next");
  let activeGalleryId = null;
  let activePhoto = 0;

  function galleryButtons() {
    const thumbnails = [...document.querySelectorAll(`.product-thumbnail[data-gallery-id="${CSS.escape(activeGalleryId)}"]`)];
    if (thumbnails.length) return thumbnails;
    return [...document.querySelectorAll(`.product-main-image[data-gallery-id="${CSS.escape(activeGalleryId)}"]`)];
  }

  function showPhoto(index) {
    const buttons = galleryButtons();
    if (!buttons.length) return;
    activePhoto = (index + buttons.length) % buttons.length;
    const button = buttons[activePhoto];
    lightboxImage.src = button.dataset.fullSrc;
    lightboxImage.alt = button.dataset.caption;
    lightboxCaption.textContent = button.dataset.caption;
    previousButton.disabled = buttons.length < 2;
    nextButton.disabled = buttons.length < 2;
  }

  document.addEventListener("click", event => {
    const button = event.target.closest(".gallery-trigger");
    if (!button) return;
    activeGalleryId = button.dataset.galleryId;
    const buttons = galleryButtons();
    activePhoto = Math.max(0, buttons.findIndex(item => item.dataset.fullSrc === button.dataset.fullSrc));
    showPhoto(activePhoto);
    lightbox.showModal();
  });

  lightbox.querySelector(".lightbox-close").addEventListener("click", () => lightbox.close());
  previousButton.addEventListener("click", () => showPhoto(activePhoto - 1));
  nextButton.addEventListener("click", () => showPhoto(activePhoto + 1));
  lightbox.addEventListener("click", event => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") showPhoto(activePhoto - 1);
    if (event.key === "ArrowRight") showPhoto(activePhoto + 1);
  });
}
