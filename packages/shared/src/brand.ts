// 品牌常量：产品名与 logo 资源路径的唯一出处。
// 侧栏、顶栏、站点设置兜底等所有引用都从这里取，避免同一个字面量散落在各包。

export const PRODUCT_NAME = 'tmex';

/** 前端 public 目录下的品牌 logo（index.html 的 favicon / PWA manifest 另有静态资源）。 */
export const BRAND_LOGO_SRC = '/logo.png';
