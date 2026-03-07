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
    this.#value = this.#reducer(this.#value, action);
  }
}

export const storeOf = <State, Action>(
  reducer: (state: State, action: Action) => State,
  initialState: State,
) => new Store(reducer, initialState);
