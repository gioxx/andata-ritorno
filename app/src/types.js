/** @typedef {{ id:string, name:string, order:number, createdAt:string, updatedAt:string }} Tab */
/** @typedef {{ id:string, tabId:string, location:'school'|'home', label:string, category?:string,
 *   photoId:string, photoAt?:string, createdAt:string, movedAt:string, updatedAt:string }} Item */
/** nameKey = dictionary key of a default category (shown translated until renamed).
 * @typedef {{ id:string, name:string, nameKey?:string, order:number, createdAt:string, updatedAt:string }} Category */
/** @typedef {{ id:string, blob:Blob, width:number, height:number }} Photo */
/** Incoming data from any backup format, before merging.
 * @typedef {{ tabs:Tab[], categories?:Category[], items:Item[], photos:Map<string,Blob>,
 *   failures:Failure[], childMap?:Record<string,string>, familyKit?:string|null }} Incoming */
/** @typedef {{ itemId:string, label:string, tabName:string, location:string, reason:string }} Failure  reason = stable code: incomplete | unknown-place | unreadable-photo | missing-tab | missing-photo (translated for display) */
/* Failure.location is a raw string: unknown v1 places (e.g. 'nonna') are reported as-is. */
/** @typedef {{ tabsPut:Tab[], categoriesPut:Category[], itemsPut:Item[], photosPut:Map<string,Blob>, photosDelete:string[],
 *   added:number, updated:number, metaPut?:Array<[string, any]> }} ImportPlan */
/** Deletion marker kept while syncing so a delete wins over an older edit on other devices.
 * @typedef {{ kind:'item'|'tab'|'category', id:string, deletedAt:string }} Tombstone */
/** What merging pulled sync records changes locally (db.applySyncPlan writes it in one tx).
 * photosDelete: local blobs no longer referenced; photosNeeded: referenced but not on this device;
 * pushBack: records to (re)upload because the server holds something else; changesBy: deviceId → applied records.
 * @typedef {{ tabsPut:Tab[], tabsDelete:string[], categoriesPut:Category[], categoriesDelete:string[],
 *   itemsPut:Item[], itemsDelete:string[], photosDelete:string[], tombstonesPut:Tombstone[], tombstonesDelete:string[],
 *   pushBack:{kind:string, id:string}[], photosNeeded:string[], movedOrphans:number, movedOrphansTab:string|null, changesBy:Map<string,number> }} SyncPlan */
