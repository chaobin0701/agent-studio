import { onBeforeUnmount, onMounted, type Ref } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { ElMessageBox } from "element-plus";

/** Guard in-app navigation and browser reloads using standard dialogs. */
export function useUnsavedChanges(
  dirty: Ref<boolean>,
  beforeLeave?: () => Promise<boolean>,
) {
  async function confirmDiscard() {
    // A user may revert the buffer while an older write is still in flight.
    // Flush first so navigation cannot abandon the corrective final write.
    if (beforeLeave && (await beforeLeave()) && !dirty.value) return true;
    if (!dirty.value) return true;
    try {
      await ElMessageBox.confirm("放弃未保存的修改？", "未保存修改", {
        type: "warning",
      });
      return true;
    } catch {
      return false;
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  onBeforeRouteLeave(confirmDiscard);
  onBeforeRouteUpdate(confirmDiscard);
  onMounted(() => window.addEventListener("beforeunload", beforeUnload));
  onBeforeUnmount(() =>
    window.removeEventListener("beforeunload", beforeUnload),
  );
  return confirmDiscard;
}
