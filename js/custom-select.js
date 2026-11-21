import { clearChildren } from "./utils.js";

export function createCustomSelects(document, window) {
  const customSelectStates = new Map();
  let openCustomSelect = null;

  function optionsFrom(select, records, selected, label) {
    clearChildren(select);
    for (const record of records) {
      const option = document.createElement("option");
      option.value = record.value;
      option.textContent = label(record);
      option.selected = record.value === selected;
      select.appendChild(option);
    }
    syncCustomSelect(select);
  }

  function selectWithArrow(select) {
    const wrapper = document.createElement("div");
    wrapper.className = "select-wrap";
    const arrow = document.createElement("span");
    arrow.className = "select-arrow";
    arrow.setAttribute("aria-hidden", "true");
    wrapper.append(select, arrow);
    return wrapper;
  }

  function selectFocusTarget(select) {
    return customSelectStates.get(select)?.button || select;
  }

  function setSelectValue(select, value) {
    select.value = String(value);
    syncCustomSelect(select);
  }

  function closeCustomSelect(state, restoreFocus = false) {
    if (!state) return;
    state.menu.hidden = true;
    state.button.setAttribute("aria-expanded", "false");
    state.button.removeAttribute("aria-activedescendant");
    state.wrapper.classList.remove("opens-up");
    if (openCustomSelect === state) openCustomSelect = null;
    if (restoreFocus) state.button.focus();
  }

  function closeAllCustomSelects(restoreFocus = false) {
    const active = openCustomSelect;
    for (const state of customSelectStates.values()) closeCustomSelect(state, restoreFocus && state === active);
  }

  function setCustomSelectActive(state, index) {
    if (!state.options.length) return;
    state.activeIndex = index;
    for (const [optionIndex, option] of state.options.entries()) option.classList.toggle("is-active", optionIndex === index);
    const active = state.options[index];
    if (!active) state.button.removeAttribute("aria-activedescendant");
    else {
      state.button.setAttribute("aria-activedescendant", active.id);
      const optionTop = active.offsetTop;
      const optionBottom = optionTop + active.offsetHeight;
      if (optionTop < state.menu.scrollTop) state.menu.scrollTop = optionTop;
      else if (optionBottom > state.menu.scrollTop + state.menu.clientHeight) state.menu.scrollTop = optionBottom - state.menu.clientHeight;
    }
  }

  function moveCustomSelectActive(state, direction) {
    if (!state.options.length) return;
    let index = state.activeIndex;
    if (index < 0) index = direction > 0 ? -1 : state.options.length;
    for (let count = 0; count < state.options.length; count += 1) {
      index = (index + direction + state.options.length) % state.options.length;
      if (!state.options[index].disabled) { setCustomSelectActive(state, index); return; }
    }
  }

  function positionCustomSelect(state) {
    const rect = state.button.getBoundingClientRect();
    const menuHeight = state.menu.getBoundingClientRect().height || Math.min(288, state.options.length * 44 + 8);
    const opensUp = rect.bottom + menuHeight > window.innerHeight - 8 && rect.top > menuHeight;
    state.wrapper.classList.toggle("opens-up", opensUp);
  }

  function chooseCustomSelectOption(state, index) {
    const option = state.select.options[index];
    if (!option || option.disabled) return;
    const changed = state.select.value !== option.value;
    state.select.value = option.value;
    syncCustomSelect(state.select);
    closeCustomSelect(state, true);
    if (changed) state.select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function openCustomSelectMenu(state) {
    if (!state || state.select.disabled) return;
    closeAllCustomSelects();
    syncCustomSelect(state.select);
    state.menu.hidden = false;
    state.button.setAttribute("aria-expanded", "true");
    openCustomSelect = state;
    const selectedIndex = state.select.selectedIndex >= 0 && !state.options[state.select.selectedIndex]?.disabled
      ? state.select.selectedIndex
      : state.options.findIndex((option) => !option.disabled);
    if (selectedIndex >= 0) setCustomSelectActive(state, selectedIndex);
    positionCustomSelect(state);
  }

  function handleCustomSelectKeydown(event, state) {
    if (state.select.disabled) return;
    const isOpen = !state.menu.hidden;
    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeCustomSelect(state, true);
      return;
    }
    if (event.key === "Tab" && isOpen) { closeCustomSelect(state); return; }
    if (!isOpen) {
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      openCustomSelectMenu(state);
      if (event.key === "ArrowDown") moveCustomSelectActive(state, 1);
      if (event.key === "ArrowUp") moveCustomSelectActive(state, -1);
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); moveCustomSelectActive(state, 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveCustomSelectActive(state, -1); }
    else if (event.key === "Home") { event.preventDefault(); setCustomSelectActive(state, state.options.findIndex((option) => !option.disabled)); }
    else if (event.key === "End") {
      event.preventDefault();
      let lastIndex = -1;
      for (let index = state.options.length - 1; index >= 0; index -= 1) {
        if (!state.options[index].disabled) { lastIndex = index; break; }
      }
      setCustomSelectActive(state, lastIndex);
    }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseCustomSelectOption(state, state.activeIndex); }
  }

  function syncCustomSelect(select) {
    const state = customSelectStates.get(select);
    if (!state) return;
    const options = [...select.options];
    clearChildren(state.menu);
    state.options = options.map((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "select-option";
      button.id = `${select.id}-option-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(option.value === select.value));
      button.disabled = select.disabled || option.disabled;
      button.textContent = option.textContent;
      button.addEventListener("click", () => chooseCustomSelectOption(state, index));
      state.menu.appendChild(button);
      return button;
    });
    const selected = options[select.selectedIndex];
    state.button.textContent = selected?.textContent || "";
    state.button.disabled = select.disabled;
    if (state.menu.hidden) state.button.setAttribute("aria-expanded", "false");
    if (state.menu.hidden) state.button.removeAttribute("aria-activedescendant");
  }

  function destroyCustomSelect(select) {
    const state = customSelectStates.get(select);
    if (!state) return;
    closeCustomSelect(state);
    state.button.remove();
    state.menu.remove();
    select.classList.remove("select-native");
    select.removeAttribute("aria-hidden");
    select.removeAttribute("tabindex");
    state.wrapper.classList.remove("is-custom", "opens-up");
    customSelectStates.delete(select);
  }

  function enhanceCustomSelect(select) {
    if (!select || customSelectStates.has(select)) return customSelectStates.get(select);
    const wrapper = select.closest(".select-wrap");
    if (!wrapper) return null;
    const label = document.querySelector(`label[for="${select.id}"]`);
    if (label) label.id ||= `${select.id}-label`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "select-button";
    button.id = `${select.id}-button`;
    button.setAttribute("role", "combobox");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    if (label) button.setAttribute("aria-labelledby", label.id);
    const menu = document.createElement("div");
    menu.className = "select-menu";
    menu.id = `${select.id}-menu`;
    menu.setAttribute("role", "listbox");
    if (label) menu.setAttribute("aria-labelledby", label.id);
    menu.hidden = true;
    button.setAttribute("aria-controls", menu.id);
    const state = { select, wrapper, button, menu, options: [], activeIndex: -1 };
    customSelectStates.set(select, state);
    select.classList.add("select-native");
    select.setAttribute("aria-hidden", "true");
    select.setAttribute("tabindex", "-1");
    wrapper.classList.add("is-custom");
    wrapper.insertBefore(button, select);
    wrapper.appendChild(menu);
    if (label) label.addEventListener("click", (event) => { event.preventDefault(); state.button.focus(); });
    button.addEventListener("click", () => (state.menu.hidden ? openCustomSelectMenu(state) : closeCustomSelect(state, true)));
    button.addEventListener("keydown", (event) => handleCustomSelectKeydown(event, state));
    syncCustomSelect(select);
    return state;
  }

  function syncSelectionControls() {
    for (const select of customSelectStates.keys()) {
      syncCustomSelect(select);
      if (select.disabled) closeCustomSelect(customSelectStates.get(select));
    }
  }

  function closeSelectOutside(target) {
    if (!openCustomSelect?.wrapper.contains(target)) closeAllCustomSelects();
  }

  return { optionsFrom, selectWithArrow, selectFocusTarget, setSelectValue, closeAllCustomSelects,
    syncCustomSelect, destroyCustomSelect, enhanceCustomSelect, syncSelectionControls, closeSelectOutside };
}
