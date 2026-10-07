import { createRoot } from "react-dom/client";
import { RouterProvider, createHashHistory } from "@tanstack/react-router";
import { getRouter } from "../src/router";
import "../src/styles.css";
import "./fonts.css";

const router = getRouter();
router.update({ history: createHashHistory(), context: router.options.context });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
