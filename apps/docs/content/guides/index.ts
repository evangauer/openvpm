import type { Guide } from "../types";
import { administration } from "./administration";
import { checkout } from "./checkout";
import { clientCare } from "./client-care";
import { clinicalCare } from "./clinical-care";
import { frontDesk } from "./front-desk";
import { startHere } from "./start-here";

export const guides: Guide[] = [...startHere, ...frontDesk, ...clinicalCare, ...checkout, ...clientCare, ...administration];
