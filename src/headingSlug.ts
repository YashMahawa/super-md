export function headingSlug(text:string):string {
  return text.normalize('NFKC').toLowerCase().replace(/<[^>]+>/g,'').replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s/g,'-')||'section';
}
