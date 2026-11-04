import { taskQuerySchema, userQuerySchema } from "../src/schemas/request.schemas";

/**
 * sortBy vocabulary (review follow-up): the enum must accept exactly the fields the
 * sort= parser also accepts for the same resource, so the two ways of sorting never disagree.
 */
describe("sortBy vocabulary matches sort= per resource", () => {
  it("tasks accept createdAt, title and completed; anything else is rejected", () => {
    for (const sortBy of ["createdAt", "title", "completed"]) {
      expect(taskQuerySchema.parse({ sortBy }).sortBy).toBe(sortBy);
    }
    expect(taskQuerySchema.safeParse({ sortBy: "role" }).success).toBe(false);
  });

  it("users accept createdAt, name, email and role; anything else is rejected", () => {
    for (const sortBy of ["createdAt", "name", "email", "role"]) {
      expect(userQuerySchema.parse({ sortBy }).sortBy).toBe(sortBy);
    }
    expect(userQuerySchema.safeParse({ sortBy: "completed" }).success).toBe(false);
  });
});
