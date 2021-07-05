import { BProps } from "./interface/b";
/**
 * @title A
 */
export interface AProps extends BProps {
  /**
   * @zh 是否禁用
   * @en Whether to disable
   */
  disabled?: boolean;
  /**
   * @zh 动画
   * @en animation
   */
  animation?: boolean;
}

export interface CProps {
  /**
   * @zh BB
   * @en bb
   */
  bb?: boolean;
}
