import { ReactNode } from "react";
import { AProps, CProps as DProps } from "./a";

/**
 * @title Alert
 * @zh
 * 向用户显示警告的信息时，通过警告提示，展现需要关注的信息。
 * @en
 * Display warning information to the user. the Alert is used to display the information that needs attention.
 */
export interface AlertProps extends Omit<Pick<AProps, 'animation'>, "disabled"> {
  style: string;
  /**
   * @zh 自定义操作项
   * @en this is action
   * @version 2.15.0
   */
  action?: ReactNode;
  /**
   * @zh 是否可以关闭
   * @en Whether Alert can be closed
   * @defaultValue false
   */
  closable?: InnerProps;
}

interface InnerProps extends AProps {
  /**
   * @zh 位置
   * @en position
   */
  position?: string;
  /**
   * @zh 尺寸
   * @en Size
   */
  size?: string;
}
