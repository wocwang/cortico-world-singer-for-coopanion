/** 包入口：默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { SINGER } from './definition.ts';

export default SINGER;
export { SINGER };
export type { SingerConfigSection } from './config.ts';
