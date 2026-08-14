'use strict';
/**
 * LAWBOR desktop — nav.cjs  (QUI a le droit de faire naviguer le pod, et vers ou)
 * ==============================================================================
 * Une seule regle, deux cablages. `main.cjs` la posait en ligne dans `setWindowOpenHandler`, donc
 * elle vivait hors de `lib/` — or l'en-tete de `test/desktop.test.js` dit la convention de ce
 * dossier: « everything with a decision in it lives in desktop/lib/* and is pinned here ». Une regle
 * de securite ecrite dans une lambda d'Electron n'est lancable par aucun test offline.
 *
 * ⛔ CE QUE CETTE REGLE PROTEGE. `setWindowOpenHandler` ne couvre que `window.open` et les liens
 * `target=_blank`. Il ne voit PAS une navigation de la fenetre elle-meme (`location.href = ...`, un
 * lien sans target, une soumission de formulaire). Or si le pod quittait `index.html` pour une
 * origine distante, cette page distante heriterait du MEME preload: elle aurait `window.lawbor`,
 * donc `say()`, `accept()`, `block()` et `win('quit')`, tous cables sur le noeud local.
 *
 * ⚖️ CE N'EST PAS UN TROU OUVERT AUJOURD'HUI, ET IL FAUT LE DIRE: toute donnee de pair atteint le
 * DOM par `textContent` — `test/desktop.test.js` l'asserte, et le panneau n'a aucun sink HTML. Il
 * n'existe donc aucun chemin connu d'un message hostile vers une navigation. C'est de la defense en
 * profondeur: le jour ou quelqu'un rend un `<a href>` a partir d'une donnee de pair, la barriere
 * existe deja.
 *
 * ⚖️ ET LE PANNEAU LUI-MEME RESTE AUTORISE. `main.cjs` recharge la fenetre quand le renderer meurt
 * (`render-process-gone` → `win.reload()`). Je n'ai pas pu mesurer si Electron emet `will-navigate`
 * dans ce cas — Electron n'est pas installe ici — donc plutot que de parier, la regle autorise
 * explicitement l'URL du panneau. Les deux branches sont vraies.
 */

/**
 * @param {string} url        l'URL vers laquelle on veut aller
 * @param {string} panelHref  l'URL file:// du panneau, cf. pathToFileURL(index.html)
 * @returns {'allow'|'external'|'deny'}
 *   allow    — c'est notre propre panneau (chargement initial, rechargement, ancre)
 *   external — une URL https: on la confie au navigateur du systeme, jamais au pod
 *   deny     — tout le reste, y compris file:, data:, javascript: et http: en clair
 */
function decideNavigation(url, panelHref) {
  if (typeof url !== 'string' || url === '') return 'deny';
  if (typeof panelHref === 'string' && panelHref !== ''
    && (url === panelHref || url.startsWith(panelHref + '#') || url.startsWith(panelHref + '?'))) {
    return 'allow';
  }
  /* Volontairement sensible a la casse, comme la regle d'origine: elargir a `HTTPS://` ferait passer
   * PLUS d'URLs a `shell.openExternal`, et ce correctif n'est pas la pour elargir quoi que ce soit. */
  if (/^https:\/\//.test(url)) return 'external';
  return 'deny';
}

module.exports = { decideNavigation };
