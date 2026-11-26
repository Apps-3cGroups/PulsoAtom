import { forwardRef, useEffect, useRef, useState } from 'react';
import { ConfigProvider, Select as AntSelect } from 'antd';

// rc-select normally opens on mousedown. A completed click must also work
// (touch/assistive input can send click without mousedown). Keep its keyboard,
// search, blur and option-selection behavior instead of simulating DOM clicks.
const Select = forwardRef(function Select({ open, defaultOpen = false, onOpenChange,
  onDropdownVisibleChange, onClick, onMouseDownCapture, disabled, ...props }, ref) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const { componentDisabled } = ConfigProvider.useConfig();
  const inactive = disabled ?? componentDisabled;
  const currentOpen = open ?? localOpen;
  const startedOpen = useRef(false);
  useEffect(() => { if (inactive) setLocalOpen(false); }, [inactive]);
  const changeOpen = next => {
    if (open === undefined) setLocalOpen(next);
    onOpenChange?.(next);
    onDropdownVisibleChange?.(next);
  };
  return <AntSelect transitionName="" {...props} ref={ref} disabled={disabled} open={inactive ? false : currentOpen}
    onOpenChange={changeOpen}
    onMouseDownCapture={event => {
      if (event.currentTarget.contains(event.target)) startedOpen.current = currentOpen;
      onMouseDownCapture?.(event);
    }}
    onClick={event => {
      onClick?.(event);
      // Keyboard and assistive clicks have detail 0 and no corresponding mousedown.
      const wasOpen = event.detail !== 0 && startedOpen.current;
      startedOpen.current = false;
      // Portaled options bubble through React; clearing/removing a tag has its
      // own action. Neither may reopen the menu after committing a selection.
      if (inactive || event.defaultPrevented || !event.currentTarget.contains(event.target)
        || event.target.closest('.ant-select-clear, .ant-select-selection-item-remove, button, a')) return;
      if (!wasOpen && !currentOpen) changeOpen(true);
    }} />;
});
Select.Option = AntSelect.Option;
Select.OptGroup = AntSelect.OptGroup;
export default Select;
