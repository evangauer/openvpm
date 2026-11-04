import {describe,expect,it,vi,afterEach} from "vitest";
import {isApprovedRehearsalDatabase} from "../../../../test-support/rehearsal-database";
const name="openvpm_release_rehearsal_20260101_abcd";
afterEach(()=>vi.unstubAllEnvs());
describe("explicit release rehearsal database opt-in",()=>{
  it("accepts only the exact opted-in synthetic target",()=>expect(isApprovedRehearsalDatabase(name,name)).toBe(true));
  it("rejects a missing opt-in",()=>{vi.stubEnv("OPENVPM_TEST_REHEARSAL_DATABASE",undefined);expect(isApprovedRehearsalDatabase(name)).toBe(false)});
  it("rejects another rehearsal database",()=>expect(isApprovedRehearsalDatabase(name,"openvpm_release_rehearsal_20260101_dcba")).toBe(false));
  it.each(["production","openvpm","openvpm_release_rehearsal_prod_abcd","openvpm_release_rehearsal_20260101_../../prod"])("rejects an arbitrary name even when opted in: %s",value=>expect(isApprovedRehearsalDatabase(value,value)).toBe(false));
});
