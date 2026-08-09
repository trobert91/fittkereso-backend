import { Reflector } from "@nestjs/core";
import { UserRole } from "@ebike-backend/database";

export const Roles = Reflector.createDecorator<UserRole[]>();
