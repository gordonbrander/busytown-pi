export class Store<State, Action> {
  #reducer: (state: State, action: Action) => State;
  #value: State;

  constructor(
    reducer: (state: State, action: Action) => State,
    initialState: State,
  ) {
    this.#reducer = reducer;
    this.#value = initialState;
  }

  get value() {
    return this.#value;
  }

  send(action: Action) {
    const next = this.#reducer(this.#value, action);
    if (next !== this.#value) {
      this.#value = next;
      this.onChange?.(next);
    }
  }

  /**
   * A callback that is called whenever the store's state changes.
   */
  onChange: ((state: State) => void) | undefined;
}

export const storeOf = <State, Action>(
  reducer: (state: State, action: Action) => State,
  initialState: State,
) => new Store(reducer, initialState);
