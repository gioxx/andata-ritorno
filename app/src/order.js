// Display order of tabs and categories. Sync never renumbers, so two devices can give records
// the same `order`; the id breaks the tie so every device shows (and picks) the same sequence.

/** @param {{order:number, id:string}} a @param {{order:number, id:string}} b */
export const byOrder = (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
