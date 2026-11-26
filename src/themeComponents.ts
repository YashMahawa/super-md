/** Fixed component roles: no selectors, arbitrary CSS or network resources. */
import {hasReadableThemeInk,luminance,readableThemeColor} from './themeContrast';
export { themeContrast as componentContrast } from './themeContrast';
export const componentRoles = ['code-header-bg','code-header-text','inline-code-bg','inline-code-text','python-bg','python-text','python-border','python-header-bg','python-header-text','python-output-bg','python-output-text','python-output-border','python-error-bg','python-error-text','python-run-bg','python-run-text','table-bg','table-text','table-border','table-header-bg','table-header-text','table-row-alt-bg','table-row-hover-bg','callout-bg','callout-text','blockquote-bg','blockquote-text','blockquote-border',...['keyword','string','number','function','builtin','attr','type','comment'].map(k=>'syntax-'+k)];
export const componentMetrics:Record<string,[string,number,number,string]>={codeRadius:['code-radius',0,32,'px'],pythonRadius:['python-radius',0,32,'px'],tableRadius:['table-radius',0,24,'px'],calloutRadius:['callout-radius',0,32,'px'],blockquoteRadius:['blockquote-radius',0,24,'px'],tableCellPadding:['table-padding',4,24,'px'],tableHeaderWeight:['table-weight',400,900,''],codeFontScale:['code-scale',.7,1.4,'em'],pythonSourceMaxHeight:['python-height',8,60,'em'],codeBorderWidth:['code-width',0,3,'px'],pythonBorderWidth:['python-width',0,3,'px'],blockquoteBorderWidth:['blockquote-width',0,8,'px']};
const valid=(c:unknown):c is string=>typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c);
const syntax=['keyword','string','number','function','builtin','attr','type','comment'];
function mix(a:string,b:string,weight:number){return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*weight+parseInt(b.slice(i,i+2),16)*(1-weight)).toString(16).padStart(2,'0')).join('');}
export function applyComponentColors(root:HTMLElement,colors:Record<string,string>,base:Record<string,string>){
  for(const role of [...componentRoles,...syntax.map(k=>'python-syntax-'+k)]){root.style.removeProperty('--custom-'+role);root.removeAttribute('data-custom-'+role);}
  const paper=valid(base.surface)?base.surface:'#eee2d4',text=valid(base.text)?base.text:'#30251f';
  const get=(key:string,fallback:string)=>valid(colors[key])?colors[key]:fallback;
  const set=(key:string,value:string)=>{root.style.setProperty('--custom-'+key,value);root.setAttribute('data-custom-'+key,'');};
  for(const role of componentRoles)if(valid(colors[role]))set(role,colors[role]);
  const high=valid(base['surface-high'])?base['surface-high']:paper;
  const defaultCode=valid(base['code-bg'])?base['code-bg']:root.dataset.theme==='light'?mix(high,'#ffffff',.7):root.dataset.theme==='black'?'#111317':mix(paper,'#000000',.86);
  const code=get('code-bg',defaultCode),python=get('python-bg',code),output=get('python-output-bg',mix(paper,defaultCode,.6));
  const pairs:[string,string[],boolean][]=[
    ['code-header-text',[get('code-header-bg',code)],valid(colors['code-header-bg'])||valid(colors['code-bg'])],
    ['inline-code-text',[get('inline-code-bg',code)],valid(colors['inline-code-bg'])],
    ['python-text',[python],valid(colors['python-bg'])],
    ['python-header-text',[get('python-header-bg',python)],valid(colors['python-header-bg'])||valid(colors['python-bg'])||valid(colors['code-bg'])],
    ['python-output-text',[output],valid(colors['python-output-bg'])],
    ['python-error-text',[get('python-error-bg',output)],valid(colors['python-error-bg'])],
    ['python-run-text',[get('python-run-bg',base.primary??'#684c32')],valid(colors['python-run-bg'])],
    ['table-header-text',[get('table-header-bg',base['surface-high']??paper)],valid(colors['table-header-bg'])||valid(colors['table-bg'])],
    ['callout-text',[get('callout-bg',paper)],valid(colors['callout-bg'])],
    ['blockquote-text',[get('blockquote-bg',paper)],valid(colors['blockquote-bg'])],
  ];
  for(const [role,bgs,backgroundChanged] of pairs)if(valid(colors[role])||backgroundChanged)set(role,readableThemeColor(get(role,role==='python-text'?get('code-text',text):text),bgs));
  if(valid(colors['callout-bg']))for(const family of ['tip','warning','danger','info','example'])set('callout-'+family,readableThemeColor(get('callout-'+family,base.primary??text),[colors['callout-bg']]));
  if(['table-bg','table-text','table-row-alt-bg','table-row-hover-bg'].some(k=>valid(colors[k]))){
    const bg=get('table-bg',paper);let alternates=['table-row-alt-bg','table-row-hover-bg'].filter(k=>valid(colors[k]));
    let bgs=[bg,...alternates.map(k=>colors[k])];
    if(!hasReadableThemeInk(bgs)){for(const k of alternates)set(k,bg);bgs=[bg];}
    set('table-text',readableThemeColor(get('table-text',text),bgs));
  }
  // Token colours are corrected independently for ordinary code and Python:
  // a dark Python cell may coexist with a light generic code block.
  const requested=syntax.some(k=>valid(colors['syntax-'+k]));
  for(const [prefix,bg,changed] of [['',code,valid(colors['code-bg'])],['python-',python,valid(colors['python-bg'])||valid(colors['code-bg'])]] as const){
    if(!requested&&!changed)continue;
    const light=luminance(bg)>.3;
    const defaults=light?['#7d276b','#24613c','#825011','#315c88','#6f4e21','#7d3d32','#5c4e8a','#59616c']:['#dab0e4','#b7d7a5','#e6c18c','#a9c9e8','#e1bb94','#e1b0ab','#c9b9e8','#aebcc5'];
    syntax.forEach((token,i)=>set(prefix+'syntax-'+token,readableThemeColor(get('syntax-'+token,defaults[i]),[bg])));
  }
}
