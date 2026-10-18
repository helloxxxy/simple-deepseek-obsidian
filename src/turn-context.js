const notebookConnected = client => !!(client && !client.closed && client.connected !== false);

class TurnContext {
  #notebook;
  #current;
  #lost = false;

  constructor({ session, model, reasoningEffort, webEnabled, imagesEnabled, notebookMode, notebookSendMode, notebookClient, notebookIdentity, notebookEpoch, currentNotebook }) {
    Object.assign(this,{session,model,reasoningEffort,webEnabled:!!webEnabled,imagesEnabled:!!imagesEnabled,notebookMode:!!notebookMode,notebookSendMode});
    this.#current = currentNotebook;
    if (notebookMode && notebookSendMode !== 'none' && notebookConnected(notebookClient)) this.#notebook = Object.freeze({client:notebookClient,identity:notebookIdentity,epoch:notebookEpoch});
    Object.freeze(this);
  }

  get notebookClient() { return this.#notebook?.client || null; }
  get notebookIdentity() { return this.#notebook?.identity || ''; }
  get notebookRequested() { return this.notebookMode && this.notebookSendMode !== 'none'; }
  get notebookAvailable() {
    if (!this.#notebook || this.#lost) return false;
    const expected = this.#notebook, actual = this.#current();
    if (!actual || actual.client !== expected.client || actual.identity !== expected.identity || actual.epoch !== expected.epoch || !notebookConnected(expected.client)) this.#lost = true;
    return !this.#lost;
  }
  get includeReasoning() { return this.webEnabled || this.imagesEnabled || this.notebookAvailable; }

  readNotebook() {
    if (!this.notebookAvailable) return null;
    try { return this.#notebook.client.read(); }
    catch { this.#lost = true; return null; }
  }
}

module.exports = {TurnContext,notebookConnected};
