import "@xterm/xterm/css/xterm.css";
import { mount } from "svelte";
import TerminalSpike from "./TerminalSpike.svelte";
import "./style.css";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app host");

mount(TerminalSpike, { target });
