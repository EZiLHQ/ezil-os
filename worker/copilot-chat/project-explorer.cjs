'use strict';

// Installed in the pinned renderer. The Worker publishes a verified checkout for this frame.
// This changes the Explorer model only. The workspace context and configuration stay intact.
function attachRepositoryProjection(model, fileService, makeRoot, restoreRoots) {
  const frame = globalThis.document?.documentElement;
  if (!frame) return;

  const checkoutAttribute = 'data-ezil-repo-checkout';
  const readyAttribute = 'data-ezil-repo-explorer-ready';
  const context = model.contextService;
  const identity = model.uriIdentityService.extUri;
  const query = new URLSearchParams(globalThis.location.search);
  const mintedFolder = query.get('folder');
  const mint = query.get('ezil_mint');
  if (query.getAll('folder').length !== 1 || query.getAll('ezil_mint').length !== 1 ||
      !mint || !/^[A-Za-z0-9_-]{22}$/.test(mint) ||
      !/\/projects\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(mintedFolder ?? '')) return;

  let generation = 0;
  let pending;
  let requestedResource;
  const invalidate = () => {
    generation++;
    pending = undefined;
    frame.removeAttribute(readyAttribute);
  };

  const reset = () => {
    invalidate();
    if (model.roots[0]?.ezilRepositoryCheckout) {
      restoreRoots();
      model._onDidChangeRoots.fire();
    }
  };

  const sync = async () => {
    const checkout = frame.getAttribute(checkoutAttribute);
    const workspace = context.getWorkspace();
    const folder = workspace.folders[0]?.uri;
    const name = checkout?.startsWith(mintedFolder + '/') ? checkout.slice(mintedFolder.length + 1) : '';
    const valid = context.getWorkbenchState() === 2 && workspace.folders.length === 1 &&
      folder?.path === mintedFolder && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(name) &&
      !name.includes('..') && !name.endsWith('.') && !name.endsWith('.git');
    if (valid && (pending === checkout || model.roots[0]?.ezilRepositoryCheckout === checkout)) return;

    reset();
    requestedResource = valid ? folder.with({ path: checkout }) : undefined;
    if (!requestedResource) return;

    pending = checkout;
    const request = generation;
    const resource = requestedResource;
    try {
      const stat = await fileService.resolve(resource);
      if (request !== generation || frame.getAttribute(checkoutAttribute) !== checkout ||
          !stat.isDirectory || stat.isSymbolicLink || !identity.isEqual(stat.resource, resource)) return;

      const projected = makeRoot(resource, name);
      projected.ezilRepositoryCheckout = checkout;
      model._roots = [projected];
      frame.setAttribute(readyAttribute, checkout);
      model._onDidChangeRoots.fire();
    } catch {
      // The normal wrapper stays available when the checkout cannot be resolved.
    } finally {
      if (request === generation) pending = undefined;
    }
  };

  const observer = new MutationObserver(() => { void sync(); });
  observer.observe(frame, { attributeFilter: [checkoutAttribute] });
  const providers = fileService.onDidChangeFileSystemProviderRegistrations(event => {
    if (event.added && event.scheme === context.getWorkspace().folders[0]?.uri.scheme) void sync();
  });
  const fileChanges = fileService.onDidFilesChange(event => {
    if (!requestedResource) return;
    // FileChangeType.DELETED and ADDED: drop the old root and verify a replacement again.
    if (event.contains(requestedResource, 2)) {
      reset();
      void sync();
    } else if (!model.roots[0]?.ezilRepositoryCheckout && event.contains(requestedResource, 1)) {
      void sync();
    }
  });
  void sync();
  return {
    workspaceChanged() {
      invalidate();
      void sync();
    },
    dispose() {
      observer.disconnect();
      providers.dispose();
      fileChanges.dispose();
      invalidate();
    },
  };
}

const patches = [
  {
    id: 'explorer-model',
    before: 'var Qci=class{constructor(o,e,t,i,n){this.contextService=o;this.uriIdentityService=e;this._onDidChangeRoots=new R;let r=()=>this._roots=this.contextService.getWorkspace().folders.map(a=>new Sb(a.uri,t,i,n,void 0,!0,!1,!1,!1,a.name));r(),this._listener=this.contextService.onDidChangeWorkspaceFolders(()=>{r(),this._onDidChangeRoots.fire()})}',
    after: attachRepositoryProjection.toString() + '\n' +
      'var Qci=class{constructor(o,e,t,i,n){this.contextService=o;this.uriIdentityService=e;this._onDidChangeRoots=new R;let ezilRoot=(uri,name)=>new Sb(uri,t,i,n,void 0,!0,!1,!1,!1,name),r=()=>this._roots=this.contextService.getWorkspace().folders.map(a=>ezilRoot(a.uri,a.name));r(),this._listener=this.contextService.onDidChangeWorkspaceFolders(()=>{r(),this.ezilRepositoryProjection?.workspaceChanged(),this._onDidChangeRoots.fire()}),this.ezilRepositoryProjection=attachRepositoryProjection(this,t,ezilRoot,r)}',
  },
  {
    id: 'explorer-resource-lookup',
    before: 'findClosest(o){let e=this.contextService.getWorkspaceFolder(o);if(e){let t=this.roots.find(i=>this.uriIdentityService.extUri.isEqual(i.resource,e.uri));if(t)return t.find(o)}return null}dispose(){this._onDidChangeRoots.dispose(),it(this._listener)}',
    after: 'findClosest(o){const projected=this.roots[0];if(projected?.ezilRepositoryCheckout)return this.uriIdentityService.extUri.isEqualOrParent(o,projected.resource)?projected.find(o):null;let e=this.contextService.getWorkspaceFolder(o);if(e){let t=this.roots.find(i=>this.uriIdentityService.extUri.isEqual(i.resource,e.uri));if(t)return t.find(o)}return null}dispose(){this.ezilRepositoryProjection?.dispose(),this._onDidChangeRoots.dispose(),it(this._listener)}',
  },
  {
    id: 'explorer-title',
    before: 'get name(){return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace())}',
    after: 'get name(){const root=this.explorerService?.roots[0];return root?.ezilRepositoryCheckout?root.name:this.labelService.getWorkspaceLabel(this.contextService.getWorkspace())}',
  },
  {
    id: 'explorer-render-header',
    before: 't.setAttribute("aria-label",this.ariaHeaderLabel)};this._register(this.contextService.onDidChangeWorkspaceName(()=>{i(),this.updateWorkspaceTitleCase()}))',
    after: 't.setAttribute("aria-label",this.ariaHeaderLabel)};this.ezilUpdateExplorerHeader=i,this._register(this.contextService.onDidChangeWorkspaceName(()=>{i(),this.updateWorkspaceTitleCase()}))',
  },
  {
    id: 'explorer-input',
    before: 'setTreeInput(){return this.setTreeInputSequencer.queue(()=>this.doSetTreeInput())}async doSetTreeInput(){',
    after: 'setTreeInput(){return this.setTreeInputSequencer.queue(()=>{const checkout=this.explorerService.roots[0]?.ezilRepositoryCheckout;if(checkout!==this.ezilExplorerInput){this.ezilExplorerInput=checkout;this.filter?.updateConfiguration(true);this.ezilUpdateExplorerHeader?.()}return this.doSetTreeInput()})}async doSetTreeInput(){',
  },
  {
    id: 'explorer-empty-context',
    before: 'setContextKeys(e){let t=this.contextService.getWorkspace().folders,i=e?e.resource:t[t.length-1].uri;',
    after: 'setContextKeys(e){let t=this.contextService.getWorkspace().folders,root=this.explorerService.roots[0],i=e?e.resource:root?.ezilRepositoryCheckout?root.resource:t[t.length-1].uri;',
  },
  {
    id: 'explorer-filter-roots',
    before: 'updateConfiguration(){let o=!1,e=!1;this.contextService.getWorkspace().folders.forEach(t=>{let i=this.configurationService.getValue({resource:t.uri}),n=i?.files?.exclude',
    after: 'updateConfiguration(ezilSilent){let o=!1,e=!1;const root=this.explorerService.roots[0],projected=root?.ezilRepositoryCheckout?root.resource:void 0,previous=this.ezilFilterRoot,active=projected?.toString();if(previous&&previous!==active){this.hiddenExpressionPerRoot.delete(previous);this.ignoreTreesPerRoot.delete(previous);this.ignoreFileResourcesPerRoot.delete(previous)}this.ezilFilterRoot=active;(projected?[{uri:projected}]:this.contextService.getWorkspace().folders).forEach(t=>{let i=this.configurationService.getValue({resource:t.uri}),n=i?.files?.exclude',
  },
  {
    id: 'explorer-filter-refresh',
    before: '}),(o||e)&&(this.editorsAffectingFilter.clear(),this._onDidChange.fire())}async processIgnoreFile(',
    after: '}),(o||e)&&(this.editorsAffectingFilter.clear(),!ezilSilent&&this._onDidChange.fire())}async processIgnoreFile(',
  },
];

function count(source, text) {
  return source.split(text).length - 1;
}

function patchBundle(source, verify = false) {
  if (!verify) {
    for (const { id, before } of patches) {
      if (count(source, before) !== 1) throw new Error(id + ': pinned Explorer anchor must occur once');
    }
    for (const { before, after } of patches) source = source.replace(before, () => after);
  }
  for (const { id, before, after } of patches) {
    if (count(source, before) !== 0 || count(source, after) !== 1) {
      throw new Error(id + ': pinned Explorer projection verification failed');
    }
  }
  return source;
}

if (require.main === module) {
  const fs = require('node:fs');
  const verify = process.argv[2] === '--verify';
  const file = process.argv[verify ? 3 : 2];
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchBundle(source, verify);
  if (!verify) fs.writeFileSync(file, patched);
}

module.exports = { patchBundle, patches, attachRepositoryProjection };
