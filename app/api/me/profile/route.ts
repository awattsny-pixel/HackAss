import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function PATCH(
  request: NextRequest,
) {
  try {
    // Get current user from auth header
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      console.error('No auth header provided');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');

    // Look up user by token (stored as plain token in auth_tokens table during login)
    const { data: authTokenData, error: tokenError } = await supabase
      .from('auth_tokens')
      .select('user_id, expires_at')
      .eq('token', token)
      .single();

    if (tokenError || !authTokenData) {
      console.error('Token lookup error:', tokenError);
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Check if token has expired
    const expiresAt = new Date(authTokenData.expires_at);
    if (expiresAt < new Date()) {
      return NextResponse.json(
        { error: 'Token expired' },
        { status: 401 }
      );
    }

    const userId = authTokenData.user_id;
    console.log('Authenticated user:', userId);

    // Parse FormData
    const formData = await request.formData();
    const real_name = (formData.get('real_name') as string) || null;
    const bio = (formData.get('bio') as string) || null;
    const website_url = (formData.get('website_url') as string) || null;
    const profileImage = formData.get('profile_image') as File | null;

    console.log('Form data received:', { real_name, bio, website_url, hasImage: !!profileImage });

    // Validate bio length
    if (bio && bio.length > 500) {
      return NextResponse.json(
        { error: 'Bio must be 500 characters or less' },
        { status: 400 }
      );
    }

    // Build update object - include empty values to clear fields
    const updateData: Record<string, any> = {};
    updateData.real_name = real_name;
    updateData.bio = bio;
    updateData.website_url = website_url;

    // Handle file upload if provided
    if (profileImage && profileImage.size > 0) {
      try {
        const fileExt = profileImage.name.split('.').pop();
        const fileName = `${userId}-${Date.now()}.${fileExt}`;
        const filePath = `profile-images/${fileName}`;

        console.log('Uploading file:', filePath);

        // Convert File to Buffer
        const bytes = await profileImage.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // Upload to Supabase storage
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('hackass-storage')
          .upload(filePath, buffer, {
            upsert: true,
            contentType: profileImage.type,
          });

        if (uploadError) {
          console.error('File upload error:', uploadError);
          // Log the error but don't fail - still update the text fields
          console.warn('Image upload failed, but will continue with profile update');
        } else {
          // Get public URL
          const { data: urlData } = supabase.storage
            .from('hackass-storage')
            .getPublicUrl(filePath);

          if (urlData?.publicUrl) {
            updateData.profile_image_url = urlData.publicUrl;
            console.log('Image URL:', urlData.publicUrl);
          }
        }
      } catch (fileError) {
        console.error('File processing error:', fileError);
        // Log the error but don't fail - still update the text fields
        console.warn('Image processing failed, but will continue with profile update');
      }
    }

    console.log('Update data:', updateData);

    // Update user profile
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select('id, username, real_name, bio, avatar, profile_image_url, website_url, is_verified')
      .single();

    if (updateError) {
      console.error('Database update error:', updateError);
      throw updateError;
    }

    console.log('Profile updated successfully');

    return NextResponse.json({
      data: {
        id: updatedUser.id,
        username: updatedUser.username,
        real_name: updatedUser.real_name,
        bio: updatedUser.bio,
        avatar: updatedUser.avatar,
        profile_image_url: updatedUser.profile_image_url,
        website_url: updatedUser.website_url,
        is_verified: updatedUser.is_verified,
      },
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
