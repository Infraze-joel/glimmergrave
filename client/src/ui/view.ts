export interface View {
  el: HTMLElement;
  /** Re-reads GameState / ui store and updates the DOM. */
  sync(): void;
  dispose?(): void;
}
