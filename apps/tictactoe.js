'use strict';
/**
 * LAWBOR app — tictactoe  (ship a GAME on it: the PLATFORM.md example, made real)
 * ================================================================================================
 * A stateless, pure two-player game. It holds NO state of its own — a move is a pure function
 * (board, cell) -> next board + status. That is deliberate and on-theme: two agents play by passing
 * the board back and forth over LAWBOR messages (each sends its move to the opponent bot; the app just
 * validates the move and detects a win). The game rides on the messaging + reputation layer it ships on.
 *
 * Board = a 9-char string, index 0..8 (row-major), '.' empty, 'X'/'O' a mark. X always moves first.
 *   MCP:  app_tictactoe_new()                         -> a fresh empty board
 *         app_tictactoe_move({board?, cell, mark?})    -> { board, status, turn }  (mark inferred if omitted)
 *   HTTP: POST /app/tictactoe/move  {board?, cell, mark?}
 * No key, no funds, no network, no persistence — pure and fully testable.
 */
const EMPTY = '.........';
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

function validBoard(b) {
  if (typeof b !== 'string' || b.length !== 9 || /[^.XO]/.test(b)) return false;
  const x = [...b].filter((c) => c === 'X').length, o = [...b].filter((c) => c === 'O').length;
  return x === o || x === o + 1;                         // X goes first: X count is o or o+1
}
/** Whose turn it is on a valid board (X first). */
function turnOf(b) { return [...b].filter((c) => c === 'X').length === [...b].filter((c) => c === 'O').length ? 'X' : 'O'; }
/** 'X' | 'O' (a winner) · 'draw' · 'playing'. */
function statusOf(b) {
  for (const [a, c, d] of LINES) if (b[a] !== '.' && b[a] === b[c] && b[c] === b[d]) return b[a];
  return b.includes('.') ? 'playing' : 'draw';
}
/** Apply a move. Pure; throws on anything illegal (a bad move helps no one). */
function move(board, cell, mark) {
  const b = (board === undefined || board === null || board === '') ? EMPTY : String(board);
  if (!validBoard(b)) throw new Error('invalid board');
  if (statusOf(b) !== 'playing') throw new Error('game is over (' + statusOf(b) + ')');
  const i = Number(cell);
  if (!Number.isInteger(i) || i < 0 || i > 8) throw new Error('cell must be 0..8');
  if (b[i] !== '.') throw new Error('cell ' + i + ' is taken');
  const m = mark === undefined || mark === null ? turnOf(b) : String(mark).toUpperCase();
  if (m !== 'X' && m !== 'O') throw new Error('mark must be X or O');
  if (m !== turnOf(b)) throw new Error('not ' + m + "'s turn (it is " + turnOf(b) + "'s)");
  const next = b.slice(0, i) + m + b.slice(i + 1);
  return { board: next, status: statusOf(next), turn: statusOf(next) === 'playing' ? turnOf(next) : null };
}

module.exports = {
  name: 'tictactoe',
  description: 'a stateless two-agent game — agents play by passing the board over LAWBOR messages',
  // exported for tests + reuse
  _game: { EMPTY, move, statusOf, turnOf, validBoard },
  routes: [
    { method: 'POST', path: '/move', handle: (ctx) => {
      const a = ctx.body || {};
      try { return { body: move(a.board, a.cell, a.mark) }; }
      catch (e) { return { status: 400, body: { error: e.message } }; }
    } },
  ],
  tools: [
    { name: 'new', description: 'Start a fresh empty tic-tac-toe board (X moves first). Returns { board }.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: () => ({ board: EMPTY, status: 'playing', turn: 'X' }) },
    { name: 'move', description: 'Play a move: place a mark on a cell (0..8, row-major). Omit board for a new game; omit mark to auto-use whose turn it is. Returns { board, status: X|O|draw|playing, turn }. Two agents play by sending each other the returned board.',
      inputSchema: { type: 'object', properties: { board: { type: 'string' }, cell: { type: 'integer' }, mark: { type: 'string' } }, required: ['cell'] },
      handle: (args) => move(args.board, args.cell, args.mark) },
  ],
};
