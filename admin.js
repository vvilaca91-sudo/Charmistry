const loginPanel = document.querySelector(".admin-login");
const dashboard = document.querySelector(".admin-dashboard");
const loginForm = document.querySelector(".admin-login-form");
const productForm = document.querySelector(".product-form");
const productList = document.querySelector(".admin-product-list");
const loginMessage = loginPanel.querySelector(".admin-message");
const productMessage = document.querySelector(".product-message");
const listMessage = document.querySelector(".list-message");
const imageFileInput = productForm.elements.image_files;
const imageURLInput = productForm.elements.image_url;
const imagePreviewList = document.querySelector(".admin-gallery-previews");
const imageCount = document.querySelector(".admin-gallery-count");
const orderList = document.querySelector(".admin-order-list");
const orderDetails = document.querySelector(".order-details");
const orderDetailsContent = document.querySelector(".order-details-content");
const ordersMessage = document.querySelector(".orders-message");
const currency = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });
const dateTime = new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium", timeStyle: "short" });
const maxImageSize = 5 * 1024 * 1024;
const imageTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};
const categoryNames = {
  aneis: "Anéis",
  brincos: "Brincos",
  colares: "Colares",
  pulseiras: "Pulseiras"
};
let products = [];
let editingImages = [];
let pendingImageFiles = [];
let pendingImageURL = null;
let selectedCoverKey = null;
let orders = [];
let selectedOrderId = null;
let ordersLoaded = false;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function showLogin(message = "", isError = false) {
  dashboard.hidden = true;
  loginPanel.hidden = false;
  setMessage(loginMessage, message, isError);
}

async function validateImageFile(file) {
  if (!Object.hasOwn(imageTypes, file.type)) return "Formato inválido. Escolhe uma imagem JPG, PNG ou WebP.";
  if (file.size > maxImageSize) return "A imagem excede o limite de 5 MB.";

  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
    const isWebp = bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    const matchesMime = (file.type === "image/jpeg" && isJpeg) ||
      (file.type === "image/png" && isPng) ||
      (file.type === "image/webp" && isWebp);
    return matchesMime ? "" : "O conteúdo do ficheiro não corresponde a uma imagem JPG, PNG ou WebP válida.";
  } catch (error) {
    console.error("Não foi possível validar o ficheiro de imagem:", error);
    return "Não foi possível validar esta imagem. Tenta selecionar outro ficheiro.";
  }
}

function productImageKey(image) {
  return image.id ? `existing:${image.id}` : image.key;
}

function visibleProductImages() {
  const pending = pendingImageFiles.map(item => ({
    key: item.key,
    image_url: item.previewURL,
    is_pending: true,
    is_cover: item.key === selectedCoverKey,
    label: item.file.name
  }));
  if (pendingImageURL) pending.push({
    key: pendingImageURL.key,
    image_url: pendingImageURL.url,
    is_pending: true,
    is_cover: pendingImageURL.key === selectedCoverKey,
    label: "Imagem por URL"
  });
  return [...editingImages, ...pending];
}

function renderProductImages() {
  const images = visibleProductImages();
  imageCount.textContent = `${images.length} de 5 fotografias`;
  imagePreviewList.innerHTML = images.length ? images.map((image, index) => {
    const key = productImageKey(image);
    const cover = key === selectedCoverKey || (!selectedCoverKey && image.is_cover);
    return `<article class="admin-gallery-item ${cover ? "is-cover" : ""}">
      <img src="${escapeHTML(image.image_url)}" alt="Fotografia ${index + 1} do produto">
      <div class="admin-gallery-item-controls">
        <label><input type="radio" name="product_cover" value="${escapeHTML(key)}" ${cover ? "checked" : ""}> ${cover ? "Capa principal" : "Escolher capa"}</label>
        <button type="button" data-remove-image="${escapeHTML(key)}" aria-label="Remover fotografia ${index + 1}">Remover</button>
      </div>
      <small>${escapeHTML(image.label || (cover ? "Imagem principal" : "Fotografia adicional"))}</small>
    </article>`;
  }).join("") : '<p class="admin-gallery-empty">Ainda não foram adicionadas fotografias.</p>';

  const addDisabled = images.length >= 5;
  imageFileInput.disabled = addDisabled;
  document.querySelector(".admin-add-image-url").disabled = addDisabled;
  imageURLInput.disabled = addDisabled;
}

async function loadProductImages(product) {
  const { data, error } = await supabaseClient
    .from("product_images")
    .select("id, product_id, image_url, storage_path, sort_order, is_cover")
    .eq("product_id", product.id)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("Não foi possível carregar as fotografias:", error.message);
    setMessage(productMessage, `Não foi possível carregar a galeria. Confirma que executaste supabase-product-images-migration.sql: ${error.message}`, true);
    return false;
  }

  editingImages = data.map(image => ({ ...image, label: image.storage_path ? image.storage_path.split("/").pop() : "Imagem existente" }));
  if (!editingImages.length && product.image_url) {
    editingImages = [{
      key: `legacy:${product.id}`,
      product_id: product.id,
      image_url: product.image_url,
      storage_path: null,
      sort_order: 0,
      is_cover: true,
      label: "Imagem antiga (URL do produto)"
    }];
  }
  selectedCoverKey = editingImages.find(image => image.is_cover)
    ? productImageKey(editingImages.find(image => image.is_cover))
    : editingImages.length ? productImageKey(editingImages[0]) : null;
  renderProductImages();
  return true;
}

async function refreshProductImages(productId) {
  const product = products.find(item => item.id === productId);
  if (!product) return;
  const { data, error } = await supabaseClient
    .from("products")
    .select("id, image_url")
    .eq("id", productId)
    .single();
  if (error) {
    console.error("Não foi possível atualizar a imagem de capa:", error.message);
    setMessage(productMessage, `A galeria foi alterada, mas não foi possível atualizar a capa no painel: ${error.message}`, true);
    return;
  }
  product.image_url = data.image_url;
  await loadProductImages(product);
}

imageFileInput.addEventListener("change", async () => {
  const selectedFiles = [...imageFileInput.files];
  imageFileInput.value = "";
  if (!selectedFiles.length) return;
  if (visibleProductImages().length + selectedFiles.length > 5) {
    setMessage(productMessage, "Cada produto pode ter no máximo 5 fotografias, incluindo as já guardadas.", true);
    return;
  }

  for (const file of selectedFiles) {
    const validationError = await validateImageFile(file);
    if (validationError) {
      renderProductImages();
      setMessage(productMessage, `${file.name}: ${validationError}`, true);
      return;
    }
  }

  for (const file of selectedFiles) {
    pendingImageFiles.push({
      key: `file:${crypto.randomUUID()}`,
      file,
      previewURL: URL.createObjectURL(file)
    });
  }

  if (!selectedCoverKey) selectedCoverKey = pendingImageFiles[0].key;
  renderProductImages();
  setMessage(productMessage, "Pré-visualização pronta. As fotografias serão carregadas ao guardar o produto.");
});

document.querySelector(".admin-add-image-url").addEventListener("click", () => {
  const url = imageURLInput.value.trim();
  if (!url) {
    setMessage(productMessage, "Indica um URL antes de o adicionar à galeria.", true);
    return;
  }
  try {
    const parsedURL = new URL(url);
    if (!["http:", "https:"].includes(parsedURL.protocol)) throw new Error("URL inválido");
  } catch {
    setMessage(productMessage, "Indica um URL de imagem válido (http ou https).", true);
    return;
  }
  if (visibleProductImages().length >= 5) {
    setMessage(productMessage, "Cada produto pode ter no máximo 5 fotografias.", true);
    return;
  }
  if (visibleProductImages().some(image => image.image_url === url)) {
    setMessage(productMessage, "Esta imagem já está na galeria.", true);
    return;
  }

  pendingImageURL = { key: `url:${crypto.randomUUID()}`, url };
  if (!selectedCoverKey) selectedCoverKey = pendingImageURL.key;
  imageURLInput.value = "";
  renderProductImages();
  setMessage(productMessage, "URL adicionado à galeria. Será guardado ao guardar o produto.");
});

imagePreviewList.addEventListener("change", async event => {
  const radio = event.target.closest('input[name="product_cover"]');
  if (!radio) return;
  const selected = visibleProductImages().find(image => productImageKey(image) === radio.value);
  if (!selected) return;

  if (selected.is_pending) {
    selectedCoverKey = radio.value;
    renderProductImages();
    return;
  }
  if (!selected.id) {
    setMessage(productMessage, "Esta imagem antiga só pode ser convertida para galeria depois da migração SQL.", true);
    renderProductImages();
    return;
  }

  const { error } = await supabaseClient.rpc("set_product_image_cover", { p_image_id: selected.id });
  if (error) {
    console.error("Não foi possível alterar a capa:", error.message);
    setMessage(productMessage, `Não foi possível alterar a capa: ${error.message}`, true);
    renderProductImages();
    return;
  }
  selectedCoverKey = radio.value;
  await refreshProductImages(selected.product_id);
  setMessage(productMessage, "Imagem de capa atualizada.");
});

imagePreviewList.addEventListener("click", async event => {
  const removeButton = event.target.closest("[data-remove-image]");
  if (!removeButton) return;
  const key = removeButton.dataset.removeImage;
  const pendingFile = pendingImageFiles.find(item => item.key === key);
  if (pendingFile) {
    URL.revokeObjectURL(pendingFile.previewURL);
    pendingImageFiles = pendingImageFiles.filter(item => item.key !== key);
    if (selectedCoverKey === key) selectedCoverKey = null;
    if (!selectedCoverKey) {
      const fallbackCover = visibleProductImages().find(image => image.id || !image.is_pending);
      selectedCoverKey = fallbackCover ? productImageKey(fallbackCover) : pendingImageFiles[0]?.key || pendingImageURL?.key || null;
    }
    renderProductImages();
    setMessage(productMessage, "Fotografia removida da seleção.");
    return;
  }

  if (pendingImageURL?.key === key) {
    pendingImageURL = null;
    if (selectedCoverKey === key) selectedCoverKey = null;
    renderProductImages();
    setMessage(productMessage, "URL removido da seleção.");
    return;
  }

  const image = editingImages.find(item => productImageKey(item) === key);
  if (!image) return;
  if (!image.id) {
    setMessage(productMessage, "Esta imagem antiga é guardada diretamente no produto. Migra primeiro a galeria para a poderes gerir individualmente.", true);
    return;
  }
  if (!window.confirm("Remover esta fotografia do produto? O ficheiro no Storage não será apagado.")) return;
  removeButton.disabled = true;
  const { error } = await supabaseClient.rpc("delete_product_image", { p_image_id: image.id });
  if (error) {
    console.error("Não foi possível remover a fotografia:", error.message);
    setMessage(productMessage, `Não foi possível remover a fotografia: ${error.message}`, true);
    removeButton.disabled = false;
    return;
  }
  editingImages = editingImages.filter(item => item.id !== image.id);
  if (selectedCoverKey === key) selectedCoverKey = null;
  await refreshProductImages(image.product_id);
  setMessage(productMessage, "Fotografia removida. O ficheiro original foi preservado no Storage.");
});

async function savePendingProductImages(productId) {
  const { data: userData, error: userError } = await supabaseClient.auth.getUser();
  if ((pendingImageFiles.length || pendingImageURL) && (userError || !userData.user)) {
    const message = userError?.message || "A sessão expirou. Inicia sessão novamente.";
    console.error("Não foi possível verificar o utilizador para carregar imagens:", message);
    return { error: message };
  }

  const uploadedIds = new Map();
  for (const pending of pendingImageFiles) {
    if (!pending.storagePath) {
      const filePath = `${userData.user.id}/${productId}/${crypto.randomUUID()}.${imageTypes[pending.file.type]}`;
      const { data: uploadedFile, error: uploadError } = await supabaseClient.storage
        .from("product-images")
        .upload(filePath, pending.file, {
          cacheControl: "3600",
          contentType: pending.file.type,
          upsert: false
        });
      if (uploadError) {
        console.error("Não foi possível carregar a fotografia:", uploadError.message);
        return { error: `${pending.file.name}: ${uploadError.message}` };
      }
      pending.storagePath = uploadedFile.path;
      pending.imageURL = supabaseClient.storage.from("product-images").getPublicUrl(uploadedFile.path).data.publicUrl;
    }

    const { data: imageId, error: insertError } = await supabaseClient.rpc("add_product_image", {
      p_product_id: productId,
      p_image_url: pending.imageURL,
      p_storage_path: pending.storagePath
    });
    if (insertError) {
      console.error("Não foi possível associar a fotografia ao produto:", insertError.message);
      return { error: `${pending.file.name} foi carregada, mas não foi associada: ${insertError.message}` };
    }
    uploadedIds.set(pending.key, imageId);
    URL.revokeObjectURL(pending.previewURL);
    pendingImageFiles = pendingImageFiles.filter(item => item.key !== pending.key);
  }

  if (pendingImageURL) {
    const pending = pendingImageURL;
    const { data: imageId, error } = await supabaseClient.rpc("add_product_image", {
      p_product_id: productId,
      p_image_url: pending.url,
      p_storage_path: null
    });
    if (error) {
      console.error("Não foi possível associar o URL ao produto:", error.message);
      return { error: `Não foi possível guardar a imagem por URL: ${error.message}` };
    }
    uploadedIds.set(pending.key, imageId);
    pendingImageURL = null;
  }

  let coverId = uploadedIds.get(selectedCoverKey);
  if (!coverId && selectedCoverKey?.startsWith("existing:")) coverId = selectedCoverKey.slice("existing:".length);
  if (coverId) {
    const { error } = await supabaseClient.rpc("set_product_image_cover", { p_image_id: coverId });
    if (error) {
      console.error("As imagens foram carregadas, mas não foi possível definir a capa:", error.message);
      return { error: `Imagens guardadas, mas não foi possível definir a capa: ${error.message}` };
    }
  }

  return { error: null, uploadedIds };
}

async function loadProducts() {
  listMessage.textContent = "A carregar produtos...";
  listMessage.classList.remove("is-error");
  const { data, error } = await supabaseClient
    .from("products")
    .select("id, name, category, price_cents, stock, sku, is_active, image_url, description")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Não foi possível carregar os produtos:", error.message);
    setMessage(listMessage, `Erro ao carregar produtos: ${error.message}`, true);
    return;
  }

  products = data;
  productList.innerHTML = products.length ? products.map(product => `
    <tr>
      <td><strong>${escapeHTML(product.name)}</strong>${product.sku ? `<small>${escapeHTML(product.sku)}</small>` : ""}</td>
      <td>${categoryNames[product.category]}</td>
      <td>${currency.format(product.price_cents / 100)}</td>
      <td>${product.stock}</td>
      <td>${product.is_active ? "Publicado" : "Oculto"}</td>
      <td class="admin-row-actions">
        <button type="button" data-edit-id="${escapeHTML(product.id)}">Editar</button>
        <button type="button" data-delete-id="${escapeHTML(product.id)}">Apagar</button>
      </td>
    </tr>`).join("") : '<tr><td colspan="6">Ainda não existem produtos.</td></tr>';
  listMessage.textContent = "";
}

function formatOrderDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Data inválida" : dateTime.format(date);
}

function paymentStatusLabel(status) {
  return ({
    pending: "Pendente",
    paid: "Pago",
    failed: "Falhou",
    refunded: "Reembolsado",
    unknown: "Por confirmar"
  })[status] || "Desconhecido";
}

function fulfillmentStatusLabel(status) {
  return ({
    pending: "Pendente",
    processing: "Em preparação",
    shipped: "Enviada",
    delivered: "Entregue",
    cancelled: "Cancelada"
  })[status] || "Desconhecido";
}

function filteredOrders() {
  const search = document.querySelector(".orders-search").value.trim().toLocaleLowerCase("pt-PT");
  const status = document.querySelector(".orders-status-filter").value;
  const dateFrom = document.querySelector(".orders-date-from").value;
  const dateTo = document.querySelector(".orders-date-to").value;

  return orders.filter(order => {
    const matchesSearch = !search || [order.id, order.customer_name, order.customer_email]
      .some(value => String(value || "").toLocaleLowerCase("pt-PT").includes(search));
    const orderDate = String(order.created_at || "").slice(0, 10);
    return matchesSearch &&
      (!status || order.fulfillment_status === status) &&
      (!dateFrom || orderDate >= dateFrom) &&
      (!dateTo || orderDate <= dateTo);
  });
}

function renderOrders() {
  const visibleOrders = filteredOrders();
  if (!orders.length) {
    orderList.innerHTML = '<tr><td colspan="7">Ainda não existem encomendas.</td></tr>';
  } else if (!visibleOrders.length) {
    orderList.innerHTML = '<tr><td colspan="7">Não foram encontradas encomendas com estes filtros.</td></tr>';
  } else {
    orderList.innerHTML = visibleOrders.map(order => `
      <tr>
        <td><code>${escapeHTML(order.id)}</code></td>
        <td>${escapeHTML(formatOrderDate(order.created_at))}</td>
        <td><strong>${escapeHTML(order.customer_name)}</strong><small>${escapeHTML(order.customer_email)}</small></td>
        <td>${currency.format(order.total_cents / 100)}</td>
        <td><span class="payment-status status-${escapeHTML(order.payment_status)}">${escapeHTML(paymentStatusLabel(order.payment_status))}</span></td>
        <td>
          <label class="sr-only" for="order-status-${escapeHTML(order.id)}">Estado operacional</label>
          <select id="order-status-${escapeHTML(order.id)}" data-order-status="${escapeHTML(order.id)}">
            ${["pending", "processing", "shipped", "delivered", "cancelled"].map(status =>
              `<option value="${status}" ${order.fulfillment_status === status ? "selected" : ""}>${fulfillmentStatusLabel(status)}</option>`
            ).join("")}
          </select>
        </td>
        <td class="admin-row-actions">
          <button type="button" data-save-order="${escapeHTML(order.id)}">Guardar</button>
          <button type="button" data-view-order="${escapeHTML(order.id)}">Detalhes</button>
        </td>
      </tr>`).join("");
  }

  if (selectedOrderId) {
    const selectedOrder = orders.find(order => order.id === selectedOrderId);
    if (selectedOrder) renderOrderDetails(selectedOrder);
    else {
      orderDetails.hidden = true;
      selectedOrderId = null;
    }
  }
}

function renderOrderDetails(order) {
  const items = Array.isArray(order.order_items) ? order.order_items : [];
  const address = [
    order.shipping_address,
    `${order.shipping_postal_code} ${order.shipping_city}`,
    order.shipping_country
  ].filter(Boolean).join(", ");
  const itemRows = items.length ? items.map(item => `
    <tr>
      <td>${escapeHTML(item.product_name)}</td>
      <td>${item.quantity}</td>
      <td>${currency.format(item.unit_price_cents / 100)}</td>
      <td>${currency.format(item.unit_price_cents * item.quantity / 100)}</td>
    </tr>`).join("") : '<tr><td colspan="4">Esta encomenda não tem artigos disponíveis.</td></tr>';

  orderDetailsContent.innerHTML = `
    <dl class="order-contact">
      <div><dt>Encomenda</dt><dd>${escapeHTML(order.id)}</dd></div>
      <div><dt>Data</dt><dd>${escapeHTML(formatOrderDate(order.created_at))}</dd></div>
      <div><dt>Cliente</dt><dd>${escapeHTML(order.customer_name)}</dd></div>
      <div><dt>Email</dt><dd><a href="mailto:${escapeHTML(order.customer_email)}">${escapeHTML(order.customer_email)}</a></dd></div>
      <div><dt>Telefone</dt><dd>${escapeHTML(order.customer_phone || "Não indicado")}</dd></div>
      <div><dt>Morada de entrega</dt><dd>${escapeHTML(address)}</dd></div>
      <div><dt>Pagamento</dt><dd>${escapeHTML(paymentStatusLabel(order.payment_status))}</dd></div>
      <div><dt>Estado operacional</dt><dd>${escapeHTML(fulfillmentStatusLabel(order.fulfillment_status))}</dd></div>
    </dl>
    <div class="admin-table-wrap">
      <table>
        <thead><tr><th>Produto</th><th>Quantidade</th><th>Preço unitário</th><th>Subtotal</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
    </div>
    <div class="order-totals">
      <p><span>Subtotal dos artigos</span><strong>${currency.format(order.subtotal_cents / 100)}</strong></p>
      <p><span>Envio</span><strong>${currency.format(order.shipping_cents / 100)}</strong></p>
      <p><span>Total</span><strong>${currency.format(order.total_cents / 100)}</strong></p>
    </div>`;
  orderDetails.hidden = false;
}

async function loadOrders() {
  setMessage(ordersMessage, "A carregar encomendas...");
  const pageSize = 500;
  const loadedOrders = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabaseClient
      .from("orders")
      .select("id, customer_name, customer_email, customer_phone, shipping_address, shipping_postal_code, shipping_city, shipping_country, subtotal_cents, shipping_cents, total_cents, payment_status, fulfillment_status, created_at, order_items(id, product_name, unit_price_cents, quantity)")
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error("Não foi possível carregar as encomendas:", error.message);
      setMessage(ordersMessage, `Erro ao carregar encomendas: ${error.message}`, true);
      return;
    }
    loadedOrders.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  orders = loadedOrders;
  ordersLoaded = true;
  setMessage(ordersMessage, "");
  renderOrders();
}

document.querySelectorAll(".admin-tab").forEach(tab => {
  tab.addEventListener("click", async () => {
    const showOrders = tab.id === "orders-tab";
    document.querySelectorAll(".admin-tab").forEach(item => {
      const active = item === tab;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
    });
    document.querySelector("#products-panel").hidden = showOrders;
    document.querySelector("#orders-panel").hidden = !showOrders;
    if (showOrders && !ordersLoaded) await loadOrders();
  });
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".admin-tab")];
    const currentIndex = tabs.indexOf(tab);
    const nextIndex = (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  });
});

document.querySelector(".orders-refresh").addEventListener("click", loadOrders);
[".orders-search", ".orders-status-filter", ".orders-date-from", ".orders-date-to"].forEach(selector => {
  document.querySelector(selector).addEventListener("input", renderOrders);
  document.querySelector(selector).addEventListener("change", renderOrders);
});
document.querySelector(".order-details-close").addEventListener("click", () => {
  selectedOrderId = null;
  orderDetails.hidden = true;
});
orderList.addEventListener("click", async event => {
  const viewButton = event.target.closest("[data-view-order]");
  const saveButton = event.target.closest("[data-save-order]");
  if (viewButton) {
    const order = orders.find(item => item.id === viewButton.dataset.viewOrder);
    if (order) {
      selectedOrderId = order.id;
      renderOrderDetails(order);
      orderDetails.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }

  if (saveButton) {
    const order = orders.find(item => item.id === saveButton.dataset.saveOrder);
    const statusSelect = orderList.querySelector(`[data-order-status="${CSS.escape(saveButton.dataset.saveOrder)}"]`);
    if (!order || !statusSelect || statusSelect.value === order.fulfillment_status) {
      setMessage(ordersMessage, "Não existem alterações ao estado operacional.");
      return;
    }
    saveButton.disabled = true;
    setMessage(ordersMessage, "A atualizar estado operacional...");
    const { data, error } = await supabaseClient
      .from("orders")
      .update({ fulfillment_status: statusSelect.value })
      .eq("id", order.id)
      .select("id, fulfillment_status")
      .single();

    if (error) {
      console.error("Não foi possível atualizar o estado da encomenda:", error.message);
      setMessage(ordersMessage, `Erro ao atualizar encomenda: ${error.message}`, true);
      saveButton.disabled = false;
      return;
    }

    order.fulfillment_status = data.fulfillment_status;
    setMessage(ordersMessage, "Estado operacional atualizado. O pagamento não foi alterado.");
    renderOrders();
  }
});

async function openDashboard(user) {
  setMessage(loginMessage, "A verificar permissões...");
  const { data: admin, error } = await supabaseClient
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("Não foi possível verificar as permissões:", error.message);
    setMessage(loginMessage, "Não foi possível verificar as permissões de administrador. Confirma a configuração SQL.", true);
    return;
  }

  if (!admin) {
    const { error: signOutError } = await supabaseClient.auth.signOut();
    if (signOutError) {
      console.error("Não foi possível terminar a sessão sem permissões:", signOutError.message);
      showLogin("Esta conta não tem permissões de administrador e não foi possível terminar a sessão.", true);
      return;
    }
    showLogin("Esta conta não tem permissões de administrador.", true);
    return;
  }

  loginPanel.hidden = true;
  dashboard.hidden = false;
  dashboard.querySelector(".admin-account").textContent = user.email || "";
  await loadProducts();
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!loginForm.reportValidity()) return;

  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setMessage(loginMessage, "A iniciar sessão...");
  const formData = new FormData(loginForm);
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: formData.get("email"),
    password: formData.get("password")
  });
  submitButton.disabled = false;

  if (error) {
    setMessage(loginMessage, `Não foi possível iniciar sessão: ${error.message}`, true);
    return;
  }

  await openDashboard(data.user);
});

productForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!productForm.reportValidity()) return;

  for (const pending of pendingImageFiles) {
    const validationError = await validateImageFile(pending.file);
    if (validationError) {
      setMessage(productMessage, `${pending.file.name}: ${validationError}`, true);
      return;
    }
  }

  const formData = new FormData(productForm);
  const product = {
    name: String(formData.get("name")).trim(),
    description: String(formData.get("description")).trim() || null,
    price_cents: Math.round(Number(formData.get("price")) * 100),
    category: formData.get("category"),
    stock: Number(formData.get("stock")),
    sku: String(formData.get("sku")).trim() || null,
    is_active: formData.has("is_active")
  };
  if (!product.name) {
    setMessage(productMessage, "O nome do produto é obrigatório.", true);
    return;
  }
  const id = String(formData.get("id") || "");
  const saveButton = productForm.querySelector('button[type="submit"]');
  saveButton.disabled = true;
  setMessage(productMessage, "A guardar produto...");

  const result = id
    ? await supabaseClient.from("products").update(product).eq("id", id).select("*").single()
    : await supabaseClient.from("products").insert({ ...product, image_url: null }).select("*").single();

  if (result.error) {
    saveButton.disabled = false;
    console.error("Não foi possível guardar o produto:", result.error.message);
    setMessage(productMessage, `Erro ao guardar produto: ${result.error.message}`, true);
    return;
  }

  const savedProduct = result.data;
  const productIndex = products.findIndex(item => item.id === savedProduct.id);
  if (productIndex < 0) products.push(savedProduct);
  else products[productIndex] = { ...products[productIndex], ...savedProduct };

  const imageResult = await savePendingProductImages(savedProduct.id);
  saveButton.disabled = false;
  if (imageResult.error) {
    productForm.elements.id.value = savedProduct.id;
    setMessage(productMessage, `Produto guardado. ${imageResult.error}`, true);
    renderProductImages();
    await loadProducts();
    return;
  }

  await refreshProductImages(savedProduct.id);
  resetProductForm();
  setMessage(productMessage, id ? "Produto atualizado e galeria guardada." : "Produto criado e galeria guardada.");
  await loadProducts();
});

function resetProductForm() {
  pendingImageFiles.forEach(item => URL.revokeObjectURL(item.previewURL));
  pendingImageFiles = [];
  pendingImageURL = null;
  editingImages = [];
  selectedCoverKey = null;
  productForm.reset();
  productForm.elements.id.value = "";
  productForm.elements.stock.value = "0";
  productForm.elements.is_active.checked = true;
  imageURLInput.disabled = false;
  imageFileInput.disabled = false;
  imageCount.textContent = "0 de 5 fotografias";
  imagePreviewList.innerHTML = '<p class="admin-gallery-empty">Ainda não foram adicionadas fotografias.</p>';
  document.querySelector("#product-form-title").textContent = "Adicionar produto";
  productForm.querySelector('button[type="submit"]').textContent = "Guardar produto";
  document.querySelector(".admin-cancel").hidden = true;
}

document.querySelector(".admin-cancel").addEventListener("click", resetProductForm);
document.querySelector(".admin-refresh").addEventListener("click", loadProducts);
productList.addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit-id]");
  const deleteButton = event.target.closest("[data-delete-id]");

  if (editButton) {
    const product = products.find(item => item.id === editButton.dataset.editId);
    if (!product) return;
    resetProductForm();
    productForm.elements.id.value = product.id;
    productForm.elements.name.value = product.name;
    productForm.elements.description.value = product.description || "";
    productForm.elements.price.value = (product.price_cents / 100).toFixed(2);
    productForm.elements.stock.value = String(product.stock);
    productForm.elements.category.value = product.category;
    productForm.elements.image_url.value = "";
    productForm.elements.sku.value = product.sku || "";
    productForm.elements.is_active.checked = product.is_active;
    document.querySelector("#product-form-title").textContent = "Editar produto";
    productForm.querySelector('button[type="submit"]').textContent = "Guardar alterações";
    document.querySelector(".admin-cancel").hidden = false;
    const imagesLoaded = await loadProductImages(product);
    if (!imagesLoaded) return;
    productForm.scrollIntoView({ behavior: "smooth", block: "start" });
    productForm.elements.name.focus();
    return;
  }

  if (deleteButton) {
    const product = products.find(item => item.id === deleteButton.dataset.deleteId);
    if (!product || !window.confirm(`Apagar "${product.name}"? Esta ação não pode ser desfeita.`)) return;
    deleteButton.disabled = true;
    const { error } = await supabaseClient.from("products").delete().eq("id", product.id);
    if (error) {
      console.error("Não foi possível apagar o produto:", error.message);
      setMessage(listMessage, `Erro ao apagar produto: ${error.message}`, true);
      deleteButton.disabled = false;
      return;
    }
    setMessage(listMessage, "Produto apagado.");
    await loadProducts();
  }
});

document.querySelector(".admin-logout").addEventListener("click", async () => {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    console.error("Não foi possível terminar sessão:", error.message);
    setMessage(listMessage, `Erro ao terminar sessão: ${error.message}`, true);
    return;
  }
  resetProductForm();
  showLogin("Sessão terminada.");
});

async function initializeAdmin() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error("Não foi possível verificar a sessão:", error.message);
    showLogin(`Erro ao verificar sessão: ${error.message}`, true);
    return;
  }
  if (data.session) await openDashboard(data.session.user);
}

if (typeof supabaseClient === "undefined") {
  showLogin("Não foi possível carregar o cliente Supabase. Verifica a ligação à internet e a configuração.", true);
} else {
  initializeAdmin();
}
