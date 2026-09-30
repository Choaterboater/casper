// Casper site: tiny, optional helpers. Every page works without this file.
//  1. Mobile nav: adds a Menu button that folds the nav on small screens.
//  2. Copy buttons: adds "Copy" to each <div class="cmd"> install command.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");

  // 1. Mobile nav toggle
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    toggle.hidden = false;
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  // 2. Copy buttons on install commands
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy") ? resolve() : reject(new Error("copy failed"));
      } catch (error) {
        reject(error);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  var blocks = document.querySelectorAll(".cmd");
  Array.prototype.forEach.call(blocks, function (block) {
    var code = block.querySelector("code") || block.querySelector("pre");
    if (!code) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy command");
    var status = document.createElement("span");
    status.className = "visually-hidden";
    status.setAttribute("role", "status");
    button.addEventListener("click", function () {
      copyText(code.textContent.trim()).then(function () {
        button.textContent = "Copied";
        status.textContent = "Command copied";
      }, function () {
        button.textContent = "Select it";
        status.textContent = "Could not copy. Select the text instead.";
      });
      window.setTimeout(function () {
        button.textContent = "Copy";
        status.textContent = "";
      }, 2000);
    });
    block.classList.add("has-copy");
    block.appendChild(button);
    block.appendChild(status);
  });
})();
