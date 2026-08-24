document.querySelector("#app").insertAdjacentHTML("beforeend", '<p id="loaded">ES module 已加载</p>');
fetch("/assets/module.wasm").catch(() => undefined);
