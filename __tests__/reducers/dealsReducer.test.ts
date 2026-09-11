import { dealsReducer } from '../../context/dealsReducer';

describe('dealsReducer', () => {
    it('loads initial state', () => {
        const initialState: string[] = [];
        const payload = ['1', '2', '3'];
        const newState = dealsReducer(initialState, { type: 'LOAD', payload });
        expect(newState).toEqual(['1', '2', '3']);
    });

    it('adds a deal if not saved', () => {
        const state = ['1', '2'];
        const newState = dealsReducer(state, { type: 'TOGGLE', payload: '3' });
        expect(newState).toEqual(['1', '2', '3']);
    });

    it('removes a deal if already saved', () => {
        const state = ['1', '2', '3'];
        const newState = dealsReducer(state, { type: 'TOGGLE', payload: '2' });
        expect(newState).toEqual(['1', '3']);
    });

    it('handles empty state toggle', () => {
        const state: string[] = [];
        const newState = dealsReducer(state, { type: 'TOGGLE', payload: '1' });
        expect(newState).toEqual(['1']);
    });
});
