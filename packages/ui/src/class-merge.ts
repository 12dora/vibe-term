// Tailwind 类名冲突合并器：cn() 用它取代 tailwind-merge，行为对齐 tailwind-merge 3.4.0
// 的默认配置（Tailwind CSS v4）。
//
// TABLE 是 tailwind-merge 默认 classGroups 的等价压缩表，每条形如 `组名::候选1|候选2`：
//   字面量      → 该类名（按 `-` 拆成前缀树的多级）属于这一组，例如 `flex-row`
//   前缀-(嵌套) → 在该前缀下继续展开，例如 `bg-(auto|cover)`
//   .           → 前缀自身即该组，例如 border-w 的 `border`
//   <校验器>    → 剩余部分交给 VALIDATORS 里的同名校验器判定，例如 `<num>`
// 同一节点上的校验器按表中出现顺序试，字面量优先于校验器；$xxx 是 MACROS 里的公共候选集。
// CONFLICTS 描述“后者命中时要一并作废的组”，例如 `p` 命中会作废先前的 px/py/pt/…。
//
// 表和冲突关系直接取自 tailwind-merge 3.4.0 的 default-config，升级 Tailwind 时需同步。
// 与 tailwind-merge 的三处有意简化（不影响输出）：不支持 prefix / experimentalParseClassName
// 两个用不到的配置项；后缀修饰符（`text-sm/6`）的额外冲突表在默认配置里只有 font-size→leading，
// 与基础冲突表完全一致，故未单列；缓存用满即清而不是 LRU。

type Validator = (value: string) => boolean;

const ARBITRARY_VALUE = /^\[(?:(\w[\w-]*):)?(.+)\]$/i;
const ARBITRARY_VARIABLE = /^\((?:(\w[\w-]*):)?(.+)\)$/i;
const FRACTION = /^\d+\/\d+$/;
const TSHIRT_SIZE = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/;
const LENGTH_UNIT =
  /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/;
const COLOR_FUNCTION = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\(.+\)$/;
const SHADOW_VALUE = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/;
const IMAGE_VALUE =
  /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/;
const LABEL_LENGTH = /^length$/;
const LABEL_NUMBER = /^number$/;
const LABEL_SIZE = /^(length|size|bg-size)$/;
const LABEL_POSITION = /^(position|percentage)$/;
const LABEL_IMAGE = /^(image|url)$/;
const LABEL_SHADOW = /^shadow$/;
const LABEL_FAMILY = /^family-name$/;

const isNumber: Validator = (value) => !!value && !Number.isNaN(Number(value));
const isLength: Validator = (value) => LENGTH_UNIT.test(value) && !COLOR_FUNCTION.test(value);
const never: Validator = () => false;

const arbitraryValue =
  (label: RegExp, test: Validator): Validator =>
  (value) => {
    const match = ARBITRARY_VALUE.exec(value);
    if (!match) return false;
    return match[1] ? label.test(match[1]) : test(match[2]);
  };

const arbitraryVariable =
  (label: RegExp, matchNoLabel = false): Validator =>
  (value) => {
    const match = ARBITRARY_VARIABLE.exec(value);
    if (!match) return false;
    return match[1] ? label.test(match[1]) : matchNoLabel;
  };

const VALIDATORS: Record<string, Validator> = {
  any: () => true,
  nonarb: (value) => !ARBITRARY_VALUE.test(value) && !ARBITRARY_VARIABLE.test(value),
  num: isNumber,
  int: (value) => !!value && Number.isInteger(Number(value)),
  frac: (value) => FRACTION.test(value),
  pct: (value) => value.endsWith('%') && isNumber(value.slice(0, -1)),
  tshirt: (value) => TSHIRT_SIZE.test(value),
  a: (value) => ARBITRARY_VALUE.test(value),
  v: (value) => ARBITRARY_VARIABLE.test(value),
  'a-len': arbitraryValue(LABEL_LENGTH, isLength),
  'v-len': arbitraryVariable(LABEL_LENGTH),
  'a-num': arbitraryValue(LABEL_NUMBER, isNumber),
  'a-size': arbitraryValue(LABEL_SIZE, never),
  'v-size': arbitraryVariable(LABEL_SIZE),
  'a-pos': arbitraryValue(LABEL_POSITION, never),
  'v-pos': arbitraryVariable(LABEL_POSITION),
  'a-img': arbitraryValue(LABEL_IMAGE, (value) => IMAGE_VALUE.test(value)),
  'v-img': arbitraryVariable(LABEL_IMAGE),
  'a-shadow': arbitraryValue(LABEL_SHADOW, (value) => SHADOW_VALUE.test(value)),
  'v-shadow': arbitraryVariable(LABEL_SHADOW, true),
  'v-family': arbitraryVariable(LABEL_FAMILY),
};

const MACROS = `
$pos=center|top|bottom|left|right|top-left|left-top|top-right|right-top|bottom-right|right-bottom|bottom-left|left-bottom
$blend=normal|multiply|screen|overlay|darken|lighten|color-dodge|color-burn|hard-light|soft-light|difference|exclusion|hue|saturation|color|luminosity
$size=<frac>|auto|full|dvw|dvh|lvw|lvh|svw|svh|min|max|fit
$radius=.|none|full|<tshirt>|<v>|<a>
$inset=<frac>|full|auto|<v>|<a>|px|<num>
$width=.|<num>|<v-len>|<a-len>
$maskpos=<num>|<pct>|<v-pos>|<a-pos>
$shadow=<tshirt>|<v-shadow>|<a-shadow>
$align=start|end|center|stretch|center-safe|end-safe
$justify=start|end|center|between|around|evenly|stretch|baseline|center-safe|end-safe
$filter=.|<num>|<v>|<a>
$style=solid|dashed|dotted|double
$space=<v>|<a>|px|<num>
$color=<any>|<v>|<a>
$arb=<v>|<a>`;

const TABLE = `
aspect::aspect-(auto|square|<frac>|<a>|<v>|video);container::container;columns::columns-(<num>|<a>|<v>|<tshirt>)
break-after::break-after-(auto|avoid|all|avoid-page|page|left|right|column)
break-before::break-before-(auto|avoid|all|avoid-page|page|left|right|column);break-inside::break-inside-(auto|avoid|avoid-page|avoid-column)
box-decoration::box-decoration-(slice|clone);box::box-(border|content)
display::block|inline-block|inline|flex|inline-flex|table|inline-table|table-caption|table-cell|table-column|table-column-group|table-footer-group|table-header-group|table-row-group|table-row|flow-root|grid|inline-grid|contents|list-item|hidden
sr::sr-only|not-sr-only;float::float-(right|left|none|start|end);clear::clear-(left|right|both|none|start|end);isolation::isolate|isolation-auto
object-fit::object-(contain|cover|fill|none|scale-down);object-position::object-($pos|$arb);overflow::overflow-(auto|hidden|clip|visible|scroll)
overflow-x::overflow-x-(auto|hidden|clip|visible|scroll);overflow-y::overflow-y-(auto|hidden|clip|visible|scroll)
overscroll::overscroll-(auto|contain|none);overscroll-x::overscroll-x-(auto|contain|none);overscroll-y::overscroll-y-(auto|contain|none)
position::static|fixed|absolute|relative|sticky;inset::inset-($inset);inset-x::inset-x-($inset);inset-y::inset-y-($inset);start::start-($inset)
end::end-($inset);top::top-($inset);right::right-($inset);bottom::bottom-($inset);left::left-($inset);visibility::visible|invisible|collapse
z::z-(<int>|auto|$arb);basis::basis-(<frac>|full|auto|<tshirt>|$space);flex-direction::flex-(row|row-reverse|col|col-reverse)
flex-wrap::flex-(nowrap|wrap|wrap-reverse);flex::flex-(<num>|<frac>|auto|initial|none|<a>);grow::grow-($filter);shrink::shrink-($filter)
order::order-(<int>|first|last|none|$arb);grid-cols::grid-cols-(<int>|none|subgrid|$arb);col-start-end::col-(auto|span-(full|<int>|$arb)|<int>|$arb)
col-start::col-start-(<int>|auto|$arb);col-end::col-end-(<int>|auto|$arb);grid-rows::grid-rows-(<int>|none|subgrid|$arb)
row-start-end::row-(auto|span-(full|<int>|$arb)|<int>|$arb);row-start::row-start-(<int>|auto|$arb);row-end::row-end-(<int>|auto|$arb)
grid-flow::grid-flow-(row|col|dense|row-dense|col-dense);auto-cols::auto-cols-(auto|min|max|fr|$arb);auto-rows::auto-rows-(auto|min|max|fr|$arb)
gap::gap-($space);gap-x::gap-x-($space);gap-y::gap-y-($space);justify-content::justify-($justify|normal)
justify-items::justify-items-($align|normal);justify-self::justify-self-(auto|$align);align-content::content-(normal|$justify)
align-items::items-($align|baseline-(.|last));align-self::self-(auto|$align|baseline-(.|last));place-content::place-content-($justify)
place-items::place-items-($align|baseline);place-self::place-self-(auto|$align);p::p-($space);px::px-($space);py::py-($space);ps::ps-($space)
pe::pe-($space);pt::pt-($space);pr::pr-($space);pb::pb-($space);pl::pl-($space);m::m-(auto|$space);mx::mx-(auto|$space);my::my-(auto|$space)
ms::ms-(auto|$space);me::me-(auto|$space);mt::mt-(auto|$space);mr::mr-(auto|$space);mb::mb-(auto|$space);ml::ml-(auto|$space)
space-x::space-x-($space);space-x-reverse::space-x-reverse;space-y::space-y-($space);space-y-reverse::space-y-reverse;size::size-($size|$space)
w::w-(<tshirt>|screen|$size|$space);min-w::min-w-(<tshirt>|screen|none|$size|$space)
max-w::max-w-(<tshirt>|screen|none|prose|screen-(<tshirt>)|$size|$space);h::h-(screen|lh|$size|$space);min-h::min-h-(screen|lh|none|$size|$space)
max-h::max-h-(screen|lh|$size|$space);font-size::text-(base|<tshirt>|<v-len>|<a-len>);font-smoothing::antialiased|subpixel-antialiased
font-style::italic|not-italic;font-weight::font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|<v>|<a-num>)
font-stretch::font-stretch-(ultra-condensed|extra-condensed|condensed|semi-condensed|normal|semi-expanded|expanded|extra-expanded|ultra-expanded|<pct>|<a>)
font-family::font-(<v-family>|<a>|<nonarb>);fvn-normal::normal-nums;fvn-ordinal::ordinal;fvn-slashed-zero::slashed-zero
fvn-figure::lining-nums|oldstyle-nums;fvn-spacing::proportional-nums|tabular-nums;fvn-fraction::diagonal-fractions|stacked-fractions
tracking::tracking-(tighter|tight|normal|wide|wider|widest|$arb);line-clamp::line-clamp-(<num>|none|<v>|<a-num>)
leading::leading-(none|tight|snug|normal|relaxed|loose|$space);list-image::list-image-(none|$arb);list-style-position::list-(inside|outside)
list-style-type::list-(disc|decimal|none|$arb);text-alignment::text-(left|center|right|justify|start|end);placeholder-color::placeholder-($color)
text-color::text-($color);text-decoration::underline|overline|line-through|no-underline;text-decoration-style::decoration-($style|wavy)
text-decoration-thickness::decoration-(<num>|from-font|auto|<v>|<a-len>);text-decoration-color::decoration-($color)
underline-offset::underline-offset-(<num>|auto|$arb);text-transform::uppercase|lowercase|capitalize|normal-case
text-overflow::truncate|text-ellipsis|text-clip;text-wrap::text-(wrap|nowrap|balance|pretty);indent::indent-($space)
vertical-align::align-(baseline|top|middle|bottom|text-top|text-bottom|sub|super|$arb)
whitespace::whitespace-(normal|nowrap|pre|pre-line|pre-wrap|break-spaces);break::break-(normal|words|all|keep)
wrap::wrap-(break-word|anywhere|normal);hyphens::hyphens-(none|manual|auto);content::content-(none|$arb);bg-attachment::bg-(fixed|local|scroll)
bg-clip::bg-clip-(border|padding|content|text);bg-origin::bg-origin-(border|padding|content);bg-position::bg-($pos|<v-pos>|<a-pos>|position-($arb))
bg-repeat::bg-(no-repeat|repeat-(.|x|y|space|round));bg-size::bg-(auto|cover|contain|<v-size>|<a-size>|size-($arb))
bg-image::bg-(none|linear-(to-(t|tr|r|br|b|bl|l|tl)|<int>|$arb)|radial-(.|$arb)|conic-(<int>|$arb)|<v-img>|<a-img>);bg-color::bg-($color)
gradient-from-pos::from-(<pct>|<v-len>|<a-len>);gradient-via-pos::via-(<pct>|<v-len>|<a-len>);gradient-to-pos::to-(<pct>|<v-len>|<a-len>)
gradient-from::from-($color);gradient-via::via-($color);gradient-to::to-($color);rounded::rounded-($radius);rounded-s::rounded-s-($radius)
rounded-e::rounded-e-($radius);rounded-t::rounded-t-($radius);rounded-r::rounded-r-($radius);rounded-b::rounded-b-($radius)
rounded-l::rounded-l-($radius);rounded-ss::rounded-ss-($radius);rounded-se::rounded-se-($radius);rounded-ee::rounded-ee-($radius)
rounded-es::rounded-es-($radius);rounded-tl::rounded-tl-($radius);rounded-tr::rounded-tr-($radius);rounded-br::rounded-br-($radius)
rounded-bl::rounded-bl-($radius);border-w::border-($width);border-w-x::border-x-($width);border-w-y::border-y-($width);border-w-s::border-s-($width)
border-w-e::border-e-($width);border-w-t::border-t-($width);border-w-r::border-r-($width);border-w-b::border-b-($width)
border-w-l::border-l-($width);divide-x::divide-x-($width);divide-x-reverse::divide-x-reverse;divide-y::divide-y-($width)
divide-y-reverse::divide-y-reverse;border-style::border-($style|hidden|none);divide-style::divide-($style|hidden|none);border-color::border-($color)
border-color-x::border-x-($color);border-color-y::border-y-($color);border-color-s::border-s-($color);border-color-e::border-e-($color)
border-color-t::border-t-($color);border-color-r::border-r-($color);border-color-b::border-b-($color);border-color-l::border-l-($color)
divide-color::divide-($color);outline-style::outline-($style|none|hidden);outline-offset::outline-offset-(<num>|$arb);outline-w::outline-($width)
outline-color::outline-($color);shadow::shadow-(.|none|$shadow);shadow-color::shadow-($color);inset-shadow::inset-shadow-(none|$shadow)
inset-shadow-color::inset-shadow-($color);ring-w::ring-($width);ring-w-inset::ring-inset;ring-color::ring-($color)
ring-offset-w::ring-offset-(<num>|<a-len>);ring-offset-color::ring-offset-($color);inset-ring-w::inset-ring-($width)
inset-ring-color::inset-ring-($color);text-shadow::text-shadow-(none|$shadow);text-shadow-color::text-shadow-($color);opacity::opacity-(<num>|$arb)
mix-blend::mix-blend-($blend|plus-darker|plus-lighter);bg-blend::bg-blend-($blend)
mask-clip::mask-clip-(border|padding|content|fill|stroke|view)|mask-no-clip;mask-composite::mask-(add|subtract|intersect|exclude)
mask-image-linear-pos::mask-linear-(<num>);mask-image-linear-from-pos::mask-linear-from-($maskpos)
mask-image-linear-to-pos::mask-linear-to-($maskpos);mask-image-linear-from-color::mask-linear-from-($color)
mask-image-linear-to-color::mask-linear-to-($color);mask-image-t-from-pos::mask-t-from-($maskpos);mask-image-t-to-pos::mask-t-to-($maskpos)
mask-image-t-from-color::mask-t-from-($color);mask-image-t-to-color::mask-t-to-($color);mask-image-r-from-pos::mask-r-from-($maskpos)
mask-image-r-to-pos::mask-r-to-($maskpos);mask-image-r-from-color::mask-r-from-($color);mask-image-r-to-color::mask-r-to-($color)
mask-image-b-from-pos::mask-b-from-($maskpos);mask-image-b-to-pos::mask-b-to-($maskpos);mask-image-b-from-color::mask-b-from-($color)
mask-image-b-to-color::mask-b-to-($color);mask-image-l-from-pos::mask-l-from-($maskpos);mask-image-l-to-pos::mask-l-to-($maskpos)
mask-image-l-from-color::mask-l-from-($color);mask-image-l-to-color::mask-l-to-($color);mask-image-x-from-pos::mask-x-from-($maskpos)
mask-image-x-to-pos::mask-x-to-($maskpos);mask-image-x-from-color::mask-x-from-($color);mask-image-x-to-color::mask-x-to-($color)
mask-image-y-from-pos::mask-y-from-($maskpos);mask-image-y-to-pos::mask-y-to-($maskpos);mask-image-y-from-color::mask-y-from-($color)
mask-image-y-to-color::mask-y-to-($color);mask-image-radial::mask-radial-($arb);mask-image-radial-from-pos::mask-radial-from-($maskpos)
mask-image-radial-to-pos::mask-radial-to-($maskpos);mask-image-radial-from-color::mask-radial-from-($color)
mask-image-radial-to-color::mask-radial-to-($color);mask-image-radial-shape::mask-radial-(circle|ellipse)
mask-image-radial-size::mask-radial-(closest-(side|corner)|farthest-(side|corner));mask-image-radial-pos::mask-radial-at-($pos)
mask-image-conic-pos::mask-conic-(<num>);mask-image-conic-from-pos::mask-conic-from-($maskpos);mask-image-conic-to-pos::mask-conic-to-($maskpos)
mask-image-conic-from-color::mask-conic-from-($color);mask-image-conic-to-color::mask-conic-to-($color);mask-mode::mask-(alpha|luminance|match)
mask-origin::mask-origin-(border|padding|content|fill|stroke|view);mask-position::mask-($pos|<v-pos>|<a-pos>|position-($arb))
mask-repeat::mask-(no-repeat|repeat-(.|x|y|space|round));mask-size::mask-(auto|cover|contain|<v-size>|<a-size>|size-($arb))
mask-type::mask-type-(alpha|luminance);mask-image::mask-(none|$arb);filter::filter-(.|none|$arb);blur::blur-(.|none|<tshirt>|$arb)
brightness::brightness-(<num>|$arb);contrast::contrast-(<num>|$arb);drop-shadow::drop-shadow-(.|none|$shadow)
drop-shadow-color::drop-shadow-($color);grayscale::grayscale-($filter);hue-rotate::hue-rotate-(<num>|$arb);invert::invert-($filter)
saturate::saturate-(<num>|$arb);sepia::sepia-($filter);backdrop-filter::backdrop-filter-(.|none|$arb)
backdrop-blur::backdrop-blur-(.|none|<tshirt>|$arb);backdrop-brightness::backdrop-brightness-(<num>|$arb)
backdrop-contrast::backdrop-contrast-(<num>|$arb);backdrop-grayscale::backdrop-grayscale-($filter)
backdrop-hue-rotate::backdrop-hue-rotate-(<num>|$arb);backdrop-invert::backdrop-invert-($filter);backdrop-opacity::backdrop-opacity-(<num>|$arb)
backdrop-saturate::backdrop-saturate-(<num>|$arb);backdrop-sepia::backdrop-sepia-($filter);border-collapse::border-(collapse|separate)
border-spacing::border-spacing-($space);border-spacing-x::border-spacing-x-($space);border-spacing-y::border-spacing-y-($space)
table-layout::table-(auto|fixed);caption::caption-(top|bottom);transition::transition-(.|all|colors|opacity|shadow|transform|none|$arb)
transition-behavior::transition-(normal|discrete);duration::duration-(<num>|initial|$arb);ease::ease-(linear|initial|in|out|in-out|$arb)
delay::delay-(<num>|$arb);animate::animate-(none|spin|ping|pulse|bounce|$arb);backface::backface-(hidden|visible)
perspective::perspective-(dramatic|near|normal|midrange|distant|none|$arb);perspective-origin::perspective-origin-($pos|$arb)
rotate::rotate-(none|<num>|$arb);rotate-x::rotate-x-(none|<num>|$arb);rotate-y::rotate-y-(none|<num>|$arb);rotate-z::rotate-z-(none|<num>|$arb)
scale::scale-(none|<num>|$arb);scale-x::scale-x-(none|<num>|$arb);scale-y::scale-y-(none|<num>|$arb);scale-z::scale-z-(none|<num>|$arb)
scale-3d::scale-3d;skew::skew-(<num>|$arb);skew-x::skew-x-(<num>|$arb);skew-y::skew-y-(<num>|$arb);transform::transform-($arb|.|none|gpu|cpu)
transform-origin::origin-($pos|$arb);transform-style::transform-(3d|flat);translate::translate-(<frac>|full|$space)
translate-x::translate-x-(<frac>|full|$space);translate-y::translate-y-(<frac>|full|$space);translate-z::translate-z-(<frac>|full|$space)
translate-none::translate-none;accent::accent-($color);appearance::appearance-(none|auto);caret-color::caret-($color)
color-scheme::scheme-(normal|dark|light|light-dark|only-dark|only-light)
cursor::cursor-(auto|default|pointer|wait|text|move|help|not-allowed|none|context-menu|progress|cell|crosshair|vertical-text|alias|copy|no-drop|grab|grabbing|all-scroll|col-resize|row-resize|n-resize|e-resize|s-resize|w-resize|ne-resize|nw-resize|se-resize|sw-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|zoom-in|zoom-out|$arb)
field-sizing::field-sizing-(fixed|content);pointer-events::pointer-events-(auto|none);resize::resize-(none|.|y|x)
scroll-behavior::scroll-(auto|smooth);scroll-m::scroll-m-($space);scroll-mx::scroll-mx-($space);scroll-my::scroll-my-($space)
scroll-ms::scroll-ms-($space);scroll-me::scroll-me-($space);scroll-mt::scroll-mt-($space);scroll-mr::scroll-mr-($space)
scroll-mb::scroll-mb-($space);scroll-ml::scroll-ml-($space);scroll-p::scroll-p-($space);scroll-px::scroll-px-($space);scroll-py::scroll-py-($space)
scroll-ps::scroll-ps-($space);scroll-pe::scroll-pe-($space);scroll-pt::scroll-pt-($space);scroll-pr::scroll-pr-($space)
scroll-pb::scroll-pb-($space);scroll-pl::scroll-pl-($space);snap-align::snap-(start|end|center|align-none);snap-stop::snap-(normal|always)
snap-type::snap-(none|x|y|both);snap-strictness::snap-(mandatory|proximity);touch::touch-(auto|none|manipulation);touch-x::touch-pan-(x|left|right)
touch-y::touch-pan-(y|up|down);touch-pz::touch-pinch-zoom;select::select-(none|text|all|auto)
will-change::will-change-(auto|scroll|contents|transform|$arb);fill::fill-(none|$color);stroke-w::stroke-(<num>|<v-len>|<a-len>|<a-num>)
stroke::stroke-(none|$color);forced-color-adjust::forced-color-adjust-(auto|none)`;

const CONFLICTS = `
overflow>overflow-x overflow-y;overscroll>overscroll-x overscroll-y;inset>inset-x inset-y start end top right bottom left;inset-x>right left
inset-y>top bottom;flex>basis grow shrink;gap>gap-x gap-y;p>px py ps pe pt pr pb pl;px>pr pl;py>pt pb;m>mx my ms me mt mr mb ml;mx>mr ml;my>mt mb
size>w h;font-size>leading;fvn-normal>fvn-ordinal fvn-slashed-zero fvn-figure fvn-spacing fvn-fraction;fvn-ordinal>fvn-normal
fvn-slashed-zero>fvn-normal;fvn-figure>fvn-normal;fvn-spacing>fvn-normal;fvn-fraction>fvn-normal;line-clamp>display overflow
rounded>rounded-s rounded-e rounded-t rounded-r rounded-b rounded-l rounded-ss rounded-se rounded-ee rounded-es rounded-tl rounded-tr rounded-br rounded-bl
rounded-s>rounded-ss rounded-es;rounded-e>rounded-se rounded-ee;rounded-t>rounded-tl rounded-tr;rounded-r>rounded-tr rounded-br
rounded-b>rounded-br rounded-bl;rounded-l>rounded-tl rounded-bl;border-spacing>border-spacing-x border-spacing-y
border-w>border-w-x border-w-y border-w-s border-w-e border-w-t border-w-r border-w-b border-w-l;border-w-x>border-w-r border-w-l
border-w-y>border-w-t border-w-b
border-color>border-color-x border-color-y border-color-s border-color-e border-color-t border-color-r border-color-b border-color-l
border-color-x>border-color-r border-color-l;border-color-y>border-color-t border-color-b;translate>translate-x translate-y translate-none
translate-none>translate translate-x translate-y translate-z
scroll-m>scroll-mx scroll-my scroll-ms scroll-me scroll-mt scroll-mr scroll-mb scroll-ml;scroll-mx>scroll-mr scroll-ml;scroll-my>scroll-mt scroll-mb
scroll-p>scroll-px scroll-py scroll-ps scroll-pe scroll-pt scroll-pr scroll-pb scroll-pl;scroll-px>scroll-pr scroll-pl;scroll-py>scroll-pt scroll-pb
touch>touch-x touch-y touch-pz;touch-x>touch;touch-y>touch;touch-pz>touch`;

const IMPORTANT = '!';
const ARBITRARY_PROPERTY_PREFIX = 'arbitrary..';
const ORDER_SENSITIVE_MODIFIERS = new Set([
  '*',
  '**',
  'after',
  'backdrop',
  'before',
  'details-content',
  'file',
  'first-letter',
  'first-line',
  'marker',
  'placeholder',
  'selection',
]);

interface TrieNode {
  next: Map<string, TrieNode>;
  validators: [Validator, string][] | null;
  group: string | undefined;
}

const createNode = (): TrieNode => ({ next: new Map(), validators: null, group: undefined });

const descend = (node: TrieNode, path: string): TrieNode => {
  let current = node;
  for (const part of path.split('-')) {
    let next = current.next.get(part);
    if (!next) {
      next = createNode();
      current.next.set(part, next);
    }
    current = next;
  }
  return current;
};

const splitAlternatives = (defs: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < defs.length; index += 1) {
    const character = defs[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === '|' && depth === 0) {
      out.push(defs.slice(start, index));
      start = index + 1;
    }
  }
  out.push(defs.slice(start));
  return out;
};

const addAlternatives = (node: TrieNode, defs: string, group: string): void => {
  for (const def of splitAlternatives(defs)) {
    if (def === '.') {
      node.group = group;
      continue;
    }
    if (def.startsWith('<')) {
      const validator = VALIDATORS[def.slice(1, -1)];
      if (!validator) throw new Error(`未知校验器：${def}`);
      if (!node.validators) node.validators = [];
      node.validators.push([validator, group]);
      continue;
    }
    const open = def.indexOf('(');
    if (open < 0) {
      descend(node, def).group = group;
      continue;
    }
    addAlternatives(descend(node, def.slice(0, open - 1)), def.slice(open + 1, -1), group);
  }
};

const expandMacros = (table: string): string => {
  const bodies = new Map<string, string>();
  for (const line of MACROS.split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    bodies.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return table.replace(/\$[a-z]+/g, (name) => {
    const body = bodies.get(name);
    if (!body) throw new Error(`未知宏：${name}`);
    return body;
  });
};

const buildTrie = (): TrieNode => {
  const root = createNode();
  for (const entry of expandMacros(TABLE).split(/[\n;]/)) {
    if (!entry) continue;
    const separator = entry.indexOf('::');
    addAlternatives(root, entry.slice(separator + 2), entry.slice(0, separator));
  }
  return root;
};

const buildConflicts = (): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const entry of CONFLICTS.split(/[\n;]/)) {
    if (!entry) continue;
    const [group, targets] = entry.split('>');
    map.set(group, targets.split(' '));
  }
  return map;
};

let trie: TrieNode | null = null;
let conflicts: Map<string, string[]> | null = null;

const resolveGroup = (parts: string[], index: number, node: TrieNode): string | undefined => {
  if (index === parts.length) return node.group;
  const child = node.next.get(parts[index]);
  if (child) {
    const found = resolveGroup(parts, index + 1, child);
    if (found) return found;
  }
  if (!node.validators) return undefined;
  const rest = index === 0 ? parts.join('-') : parts.slice(index).join('-');
  for (const [validator, group] of node.validators) {
    if (validator(rest)) return group;
  }
  return undefined;
};

const classGroupOf = (className: string): string | undefined => {
  if (className.startsWith('[') && className.endsWith(']')) {
    const content = className.slice(1, -1);
    const colon = content.indexOf(':');
    return colon > 0 ? ARBITRARY_PROPERTY_PREFIX + content.slice(0, colon) : undefined;
  }
  const parts = className.split('-');
  // `-mt-1` 这类负值会切出一个空首段，跳过它（与 tailwind-merge 一致，假定负值用法正确）
  const start = parts[0] === '' && parts.length > 1 ? 1 : 0;
  trie ??= buildTrie();
  return resolveGroup(parts, start, trie);
};

interface ParsedClassName {
  modifiers: string[];
  important: boolean;
  base: string;
  /** `bg-red-500/50` 里 `/` 在 base 中的下标，无则 undefined */
  postfix: number | undefined;
}

const splitModifiers = (className: string) => {
  const modifiers: string[] = [];
  let brackets = 0;
  let parens = 0;
  let baseStart = 0;
  let slash = -1;
  for (let index = 0; index < className.length; index += 1) {
    const character = className[index];
    if (brackets === 0 && parens === 0) {
      if (character === ':') {
        modifiers.push(className.slice(baseStart, index));
        baseStart = index + 1;
        continue;
      }
      if (character === '/') {
        slash = index;
        continue;
      }
    }
    if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '(') parens += 1;
    else if (character === ')') parens -= 1;
  }
  return { modifiers, baseStart, slash };
};

const parseClassName = (className: string): ParsedClassName => {
  const { modifiers, baseStart, slash } = splitModifiers(className);
  const raw = modifiers.length === 0 ? className : className.slice(baseStart);
  let base = raw;
  let important = false;
  if (raw.endsWith(IMPORTANT)) {
    base = raw.slice(0, -1);
    important = true;
  } else if (raw.startsWith(IMPORTANT)) {
    // Tailwind v3 把 ! 写在前面，tailwind-merge 仍兼容
    base = raw.slice(1);
    important = true;
  }
  return {
    modifiers,
    important,
    base,
    postfix: slash > baseStart ? slash - baseStart : undefined,
  };
};

const sortModifiers = (modifiers: string[]): string[] => {
  const result: string[] = [];
  let segment: string[] = [];
  for (const modifier of modifiers) {
    if (modifier.startsWith('[') || ORDER_SENSITIVE_MODIFIERS.has(modifier)) {
      if (segment.length > 0) {
        segment.sort();
        result.push(...segment);
        segment = [];
      }
      result.push(modifier);
    } else {
      segment.push(modifier);
    }
  }
  if (segment.length > 0) {
    segment.sort();
    result.push(...segment);
  }
  return result;
};

const modifierIdOf = (parsed: ParsedClassName): string => {
  const { modifiers } = parsed;
  const chain =
    modifiers.length === 0
      ? ''
      : modifiers.length === 1
        ? modifiers[0]
        : sortModifiers(modifiers).join(':');
  return parsed.important ? chain + IMPORTANT : chain;
};

const merge = (classList: string): string => {
  const blocked = new Set<string>();
  const kept: string[] = [];
  const classNames = classList.trim().split(/\s+/);
  conflicts ??= buildConflicts();
  for (let index = classNames.length - 1; index >= 0; index -= 1) {
    const className = classNames[index];
    const parsed = parseClassName(className);
    const group =
      parsed.postfix === undefined
        ? classGroupOf(parsed.base)
        : (classGroupOf(parsed.base.slice(0, parsed.postfix)) ?? classGroupOf(parsed.base));
    if (!group) {
      kept.push(className);
      continue;
    }
    const modifierId = modifierIdOf(parsed);
    const classId = modifierId + group;
    if (blocked.has(classId)) continue;
    blocked.add(classId);
    for (const conflict of conflicts.get(group) ?? []) blocked.add(modifierId + conflict);
    kept.push(className);
  }
  return kept.reverse().join(' ');
};

const CACHE_LIMIT = 500;
const cache = new Map<string, string>();

/** 合并一串 Tailwind 类名：同组冲突后者胜，重复类名去重，非 Tailwind 类名原样保留 */
export function mergeClassNames(classList: string): string {
  const cached = cache.get(classList);
  if (cached !== undefined) return cached;
  const result = merge(classList);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(classList, result);
  return result;
}
