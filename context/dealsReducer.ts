
export type Action =
    | { type: 'LOAD', payload: string[] }
    | { type: 'TOGGLE', payload: string };

export const dealsReducer = (state: string[], action: Action): string[] => {
    switch (action.type) {
        case 'LOAD':
            return action.payload;
        case 'TOGGLE':
            return state.includes(action.payload)
                ? state.filter(savedId => savedId !== action.payload)
                : [...state, action.payload];
        default:
            return state;
    }
};
