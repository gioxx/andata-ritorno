/** @typedef {{ id:string, name:string, order:number, createdAt:string, updatedAt:string }} Tab */
/** @typedef {{ id:string, tabId:string, location:'school'|'home', label:string, category?:string,
 *   photoId:string, createdAt:string, movedAt:string, updatedAt:string }} Item */
/** @typedef {{ id:string, blob:Blob, width:number, height:number }} Photo */
/** Incoming data from any backup format, before merging.
 * @typedef {{ tabs:Tab[], items:Item[], photos:Map<string,Blob>,
 *   failures:Failure[], childMap?:Record<string,string> }} Incoming */
/** @typedef {{ itemId:string, label:string, tabName:string, location:'school'|'home', reason:string }} Failure */
/** @typedef {{ tabsPut:Tab[], itemsPut:Item[], photosPut:Map<string,Blob>, photosDelete:string[],
 *   added:number, updated:number, metaPut?:Array<[string, any]> }} ImportPlan */
