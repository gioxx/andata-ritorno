/** @typedef {{ id:string, name:string, order:number, createdAt:string, updatedAt:string }} Tab */
/** @typedef {{ id:string, tabId:string, location:'school'|'home', label:string, category?:string,
 *   photoId:string, createdAt:string, movedAt:string, updatedAt:string }} Item */
/** nameKey = dictionary key of a default category (shown translated until renamed).
 * @typedef {{ id:string, name:string, nameKey?:string, order:number, createdAt:string, updatedAt:string }} Category */
/** @typedef {{ id:string, blob:Blob, width:number, height:number }} Photo */
/** Incoming data from any backup format, before merging.
 * @typedef {{ tabs:Tab[], categories?:Category[], items:Item[], photos:Map<string,Blob>,
 *   failures:Failure[], childMap?:Record<string,string> }} Incoming */
/** @typedef {{ itemId:string, label:string, tabName:string, location:string, reason:string }} Failure  reason = stable code: incomplete | unknown-place | unreadable-photo | missing-tab | missing-photo (translated for display) */
/* Failure.location is a raw string: unknown v1 places (e.g. 'nonna') are reported as-is. */
/** @typedef {{ tabsPut:Tab[], categoriesPut:Category[], itemsPut:Item[], photosPut:Map<string,Blob>, photosDelete:string[],
 *   added:number, updated:number, metaPut?:Array<[string, any]> }} ImportPlan */
