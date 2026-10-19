import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type { ReactNode } from "react";
import { useWorkspaceMotion } from "../lib/workspaceMotion";

export function AnimatedDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  return <AnimatePresence initial={false}>{open && <DisclosureBody>{children}</DisclosureBody>}</AnimatePresence>;
}

function DisclosureBody({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const timing = useWorkspaceMotion();
  return (
    <motion.div
      inert={!present}
      className="property-disclosure"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1, transition: timing.move }}
      exit={{ height: 0, opacity: 0, transition: timing.exit }}
      style={{ overflow: "hidden" }}
    >
      <div className="property-disclosure-content">{children}</div>
    </motion.div>
  );
}
