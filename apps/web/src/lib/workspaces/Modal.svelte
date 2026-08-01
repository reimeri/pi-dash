<script lang="ts">
  import { onMount } from "svelte";

  export let title: string;
  export let description: string | undefined = undefined;
  export let onClose: () => void;
  export let closeOnEscape = true;
  export let dismissable = true;

  let layer: HTMLElement;
  let dialog: HTMLElement;

  function focusable(): HTMLElement[] {
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.closest("[hidden]"));
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = focusable();
    if (elements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    const focusIsOutside = !dialog.contains(document.activeElement);
    if (
      event.shiftKey &&
      (document.activeElement === first || focusIsOutside)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || focusIsOutside)
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  function containFocus(event: FocusEvent) {
    if (event.target instanceof Node && !dialog.contains(event.target)) {
      (focusable()[0] ?? dialog).focus();
    }
  }

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    const backgroundStates = Array.from(layer.parentElement?.children ?? [])
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== layer,
      )
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
      }));
    for (const state of backgroundStates) {
      state.element.inert = true;
      state.element.setAttribute("aria-hidden", "true");
    }
    document.addEventListener("keydown", handleKeydown, true);
    document.addEventListener("focusin", containFocus, true);
    queueMicrotask(() => {
      const initial = dialog.querySelector<HTMLElement>("[autofocus]");
      (initial ?? focusable()[0] ?? dialog).focus();
    });
    return () => {
      document.removeEventListener("keydown", handleKeydown, true);
      document.removeEventListener("focusin", containFocus, true);
      for (const state of backgroundStates) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null)
          state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      if (previous?.isConnected) previous.focus();
    };
  });
</script>

<div class="modal-layer" bind:this={layer}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="modal-title"
    aria-describedby={description ? "modal-description" : undefined}
    tabindex="-1"
    bind:this={dialog}
  >
    <header class="modal-header">
      <div>
        <h2 id="modal-title">{title}</h2>
        {#if description}
          <p id="modal-description">{description}</p>
        {/if}
      </div>
      {#if dismissable}
        <button
          class="icon-button"
          type="button"
          aria-label="Close"
          on:click={onClose}>×</button
        >
      {/if}
    </header>
    <div class="modal-body"><slot /></div>
  </div>
</div>
